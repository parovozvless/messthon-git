import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { config, assertConfig } from "./config.js";
import cookieParser from "cookie-parser";
import { GitHubRepo, githubUserExists } from "./github.js";
import { Registry, Shards, Messages, Files } from "./store.js";
import { signToken, verifyToken, hashSecret, validLogin, validSecret } from "./auth.js";

assertConfig();

const registryRepo = new GitHubRepo(config.owner, config.registryRepo, config.githubToken);
const registry = new Registry(registryRepo);
await registry.load();

const shards = new Shards(registry, config.githubToken, config.owner, config.shardPrefix, config.shardThresholdKb);
const messages = new Messages(shards, registry, config.historyLimit);
const files = new Files(shards, registry, config.chunkBytes, config.maxFileBytes);

const app = express();
app.set("trust proxy", 1);
const origins = config.clientOrigin === "*" ? true : config.clientOrigin.split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins, methods: ["GET", "POST", "PUT", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(cookieParser());
app.use(express.json({ limit: "256kb" }));

const sockets = new Map();

function online() {
  return [...sockets.keys()].sort();
}

function broadcast(payload, logins = null) {
  const data = JSON.stringify(payload);
  const targets = logins ? logins.map((l) => l.toLowerCase()) : [...sockets.keys()];
  for (const login of targets) {
    for (const ws of sockets.get(login) || []) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }
}

function convAudience(conv) {
  if (!conv) return [];
  return conv.id === "general" ? [...sockets.keys()] : conv.members;
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = verifyToken(token, config.jwtSecret);
  if (!payload) return res.status(401).json({ error: "UNAUTHORIZED" });
  req.login = payload.login;
  next();
}

const sendLimiter = new Map();
function allowSend(login) {
  const now = Date.now();
  const arr = (sendLimiter.get(login) || []).filter((t) => now - t < 10000);
  if (arr.length >= 15) return false;
  arr.push(now);
  sendLimiter.set(login, arr);
  return true;
}

function publicConv(conv, viewer) {
  const login = String(viewer || "").toLowerCase();
  const title =
    conv.type === "dm" && login
      ? conv.members.find((m) => m !== login) || conv.title
      : conv.title;
  return { id: conv.id, type: conv.type, title, members: conv.members, createdAt: conv.createdAt };
}

app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), online: online().length, shards: registry.shards });
});

// OAuth: initiate GitHub OAuth flow
app.get("/api/auth/github", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("oauth_state", state, { httpOnly: true, sameSite: "lax", maxAge: 600000 });
  const params = new URLSearchParams({
    client_id: config.githubClientId,
    redirect_uri: `${config.clientOrigin.replace(/\*$/, '')}/auth/callback`,
    scope: "read:user",
    state,
    allow_signup: "false",
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// OAuth: handle GitHub callback
app.get("/api/auth/callback", async (req, res, next) => {
  try {
    const { code, state } = req.query;
    const storedState = req.cookies?.oauth_state;
    if (!storedState || state !== storedState) {
      return res.redirect(`${config.clientOrigin}/?error=invalid_state`);
    }
    res.clearCookie("oauth_state");

    // Exchange code for access token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: config.githubClientId,
        client_secret: config.githubClientSecret,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.redirect(`${config.clientOrigin}/?error=token_exchange_failed`);
    }

    // Fetch GitHub user
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "messthon-git",
      },
    });
    if (!userRes.ok) {
      return res.redirect(`${config.clientOrigin}/?error=user_fetch_failed`);
    }
    const ghUser = await userRes.json();
    const github = ghUser.login;

    // Check/create user
    let user = registry.getUser(github);
    if (!user) {
      const exists = await githubUserExists(config.githubToken, github);
      if (!exists) {
        return res.redirect(`${config.clientOrigin}/?error=user_not_found`);
      }
      // For OAuth, we don't need deviceSecret - generate one
      const deviceSecret = crypto.randomBytes(32).toString("hex");
      user = await registry.createUser(github, hashSecret(github, deviceSecret));
    }
    registry.touchUser(user.login);

    // Create JWT and redirect with token
    const token = signToken({ login: user.login }, config.jwtSecret);
    res.redirect(`${config.clientOrigin}/?token=${encodeURIComponent(token)}`);
  } catch (err) {
    next(err);
  }
});

// Legacy auth endpoint (device secret) - kept for backward compatibility
app.post("/api/auth", async (req, res, next) => {
  try {
    const { github, deviceSecret } = req.body || {};
    if (!validLogin(github)) return res.status(400).json({ error: "INVALID_GITHUB_LOGIN" });
    if (!validSecret(deviceSecret)) return res.status(400).json({ error: "INVALID_SECRET" });

    let user = registry.getUser(github);
    if (user) {
      if (user.hash !== hashSecret(github, deviceSecret)) {
        return res.status(409).json({ error: "LOGIN_TAKEN_BY_OTHER_DEVICE" });
      }
    } else {
      const exists = await githubUserExists(config.githubToken, github);
      if (!exists) return res.status(404).json({ error: "GITHUB_USER_NOT_FOUND" });
      user = await registry.createUser(github, hashSecret(github, deviceSecret));
    }
    registry.touchUser(user.login);
    const token = signToken({ login: user.login }, config.jwtSecret);
    res.json({ token, login: user.login });
  } catch (err) {
    next(err);
  }
});

app.get("/api/me", auth, (req, res) => {
  const user = registry.getUser(req.login);
  res.json({ login: req.login, createdAt: user?.createdAt || null });
});

app.get("/api/conversations", auth, (req, res) => {
  res.json({ conversations: registry.listConvs(req.login).map((c) => publicConv(c, req.login)) });
});

app.post("/api/conversations", auth, async (req, res, next) => {
  try {
    const other = String(req.body?.with || "").trim();
    if (!validLogin(other)) return res.status(400).json({ error: "INVALID_LOGIN" });
    if (other.toLowerCase() === req.login.toLowerCase()) return res.status(400).json({ error: "SELF_DM" });
    if (!registry.getUser(other)) return res.status(404).json({ error: "USER_NOT_REGISTERED" });
    const conv = await registry.createDm(req.login, other);
    res.json({ conversation: publicConv(conv, req.login) });
  } catch (err) {
    next(err);
  }
});

app.get("/api/conversations/:id/messages", auth, async (req, res, next) => {
  try {
    const conv = registry.getConv(req.params.id);
    if (!registry.canAccess(conv, req.login)) return res.status(403).json({ error: "FORBIDDEN" });
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const list = await messages.history(conv.id, limit);
    res.json({ messages: list, conversation: publicConv(conv, req.login) });
  } catch (err) {
    next(err);
  }
});

async function postMessage(login, convId, text, fileId) {
  const conv = registry.getConv(convId);
  if (!registry.canAccess(conv, login)) throw Object.assign(new Error("FORBIDDEN"), { status: 403 });
  const body = String(text || "").slice(0, 4000).trim();
  let file = null;
  if (fileId) {
    const meta = files.meta(fileId);
    if (!meta || meta.conv !== convId) throw Object.assign(new Error("BAD_FILE"), { status: 400 });
    file = { id: meta.id, name: meta.name, size: meta.size, mime: meta.mime };
  }
  if (!body && !file) throw Object.assign(new Error("EMPTY"), { status: 400 });
  const message = { id: crypto.randomUUID(), from: login, text: body, ts: Date.now(), file };
  await messages.append(conv.id, message);
  broadcast({ type: "msg", conversationId: conv.id, message }, convAudience(conv));
  return message;
}

app.post("/api/conversations/:id/messages", auth, async (req, res, next) => {
  try {
    if (!allowSend(req.login)) return res.status(429).json({ error: "RATE_LIMIT" });
    const message = await postMessage(req.login, req.params.id, req.body?.text, req.body?.fileId);
    res.json({ message });
  } catch (err) {
    next(err);
  }
});

app.post("/api/files/start", auth, (req, res, next) => {
  try {
    const convId = String(req.body?.convId || "");
    const conv = registry.getConv(convId);
    if (!registry.canAccess(conv, req.login)) return res.status(403).json({ error: "FORBIDDEN" });
    const info = files.start(req.login, {
      name: req.body?.name,
      size: Number(req.body?.size),
      mime: req.body?.mime,
      convId,
    });
    res.json(info);
  } catch (err) {
    next(err);
  }
});

app.put("/api/files/:id/chunk", auth, express.raw({ type: () => true, limit: config.chunkBytes + 4096 }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "EMPTY_CHUNK" });
    const index = Number(req.query.index);
    const result = await files.chunk(req.params.id, index, req.body, req.login);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post("/api/files/:id/complete", auth, async (req, res, next) => {
  try {
    const meta = await files.complete(req.params.id, req.login);
    res.json({ file: { id: meta.id, name: meta.name, size: meta.size, mime: meta.mime } });
  } catch (err) {
    next(err);
  }
});

app.get("/api/files/:id/meta", auth, (req, res) => {
  const meta = files.meta(req.params.id);
  if (!meta) return res.status(404).json({ error: "NOT_FOUND" });
  const conv = registry.getConv(meta.conv);
  if (!registry.canAccess(conv, req.login)) return res.status(403).json({ error: "FORBIDDEN" });
  res.json({ file: { id: meta.id, name: meta.name, size: meta.size, mime: meta.mime, chunks: meta.chunks } });
});

app.get("/api/files/:id/chunk/:n", auth, async (req, res, next) => {
  try {
    const meta = files.meta(req.params.id);
    if (!meta) return res.status(404).json({ error: "NOT_FOUND" });
    const conv = registry.getConv(meta.conv);
    if (!registry.canAccess(conv, req.login)) return res.status(403).json({ error: "FORBIDDEN" });
    const data = await files.chunkData(meta, Number(req.params.n));
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", data.length);
    res.end(data);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "TOO_LARGE" });
  const status = err?.status || 500;
  if (status >= 500) console.error("[http]", err);
  res.status(status).json({ error: err.message || "INTERNAL" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/ws") return socket.destroy();
  const payload = verifyToken(url.searchParams.get("token") || "", config.jwtSecret);
  if (!payload) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, payload));
});

wss.on("connection", (ws, payload) => {
  const login = payload.login.toLowerCase();
  ws.isAlive = true;
  if (!sockets.has(login)) sockets.set(login, new Set());
  sockets.get(login).add(ws);

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  send({
    type: "welcome",
    login,
    online: online(),
    conversations: registry.listConvs(login).map((c) => publicConv(c, login)),
  });
  broadcast({ type: "presence", online: online() });

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (raw) => {
    let packet;
    try {
      packet = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (packet.type === "ping") return send({ type: "pong" });
    if (packet.type === "typing") {
      const conv = registry.getConv(packet.conversationId);
      if (registry.canAccess(conv, login)) {
        broadcast({ type: "typing", conversationId: conv.id, login }, convAudience(conv));
      }
      return;
    }
    if (packet.type === "msg") {
      if (!allowSend(login)) return send({ type: "error", error: "RATE_LIMIT" });
      try {
        await postMessage(login, packet.conversationId, packet.text, packet.fileId);
      } catch (err) {
        send({ type: "error", error: err.message });
      }
    }
  });

  ws.on("close", () => {
    const set = sockets.get(login);
    if (set) {
      set.delete(ws);
      if (!set.size) sockets.delete(login);
    }
    broadcast({ type: "presence", online: online() });
  });
  ws.on("error", () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 30000);
heartbeat.unref?.();

const growTimer = setInterval(() => shards.maybeGrow(), 10 * 60_000);
growTimer.unref?.();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);
  try {
    await messages.flushAll();
    await registry.flush();
  } catch (err) {
    console.error("[shutdown]", err.message);
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(config.port, () => {
  console.log(`[messthon] listening on :${config.port}`);
  console.log(`[messthon] registry=${config.owner}/${config.registryRepo} shard=${registry.shards.current} threshold=${config.shardThresholdKb}KB`);
});
