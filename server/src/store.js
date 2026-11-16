import crypto from "node:crypto";
import { GitHubRepo, createRepo } from "./github.js";

const GENERAL_ID = "general";

export class Registry {
  constructor(repo) {
    this.repo = repo;
    this.accounts = { users: {} };
    this.convs = { convs: {} };
    this.files = { files: {} };
    this.shards = { current: 1, list: [1] };
    this.sha = {};
    this.queues = {};
    this.dirty = new Set();
  }

  async load() {
    const names = ["accounts", "convs", "files", "shards"];
    const loaded = await Promise.all(
      names.map((n) => this.repo.getJson(`${n}.json`).catch(() => null))
    );
    const [a, c, f, s] = loaded;
    this.accounts = a?.data || { users: {} };
    this.convs = c?.data || { convs: {} };
    this.files = f?.data || { files: {} };
    this.shards = s?.data || { current: 1, list: [1], bytes: {} };
    for (const [i, n] of names.entries()) {
      const loadedItem = (await Promise.all(
        names.map((n) => this.repo.getJson(`${n}.json`).catch(() => null))
      ))[i];
      if (loadedItem) this.sha[n] = loadedItem.sha;
    }

    if (!this.convs.convs[GENERAL_ID]) {
      this.convs.convs[GENERAL_ID] = {
        id: GENERAL_ID,
        type: "room",
        title: "general",
        members: [],
        shard: 1,
        createdAt: Date.now(),
      };
      await this.save("convs");
    }
    
    // Ensure bytes object exists
    if (!this.shards.bytes) this.shards.bytes = {};
  }

  save(name) {
    this.dirty.add(name);
    this.queues[name] = (this.queues[name] || Promise.resolve())
      .then(async () => {
        const path = `${name}.json`;
        const res = await this.repo.putFile(path, JSON.stringify(this[name]), `${name}: update`, this.sha[name]);
        if (res?.sha) this.sha[name] = res.sha;
        this.dirty.delete(name);
      })
      .catch((err) => {
        console.error(`[registry] save ${name} failed:`, err.message);
      });
    return this.queues[name];
  }

  async flush() {
    for (const name of Object.keys(this.queues)) await this.queues[name];
  }

  getUser(login) {
    return this.accounts.users[login.toLowerCase()] || null;
  }

  async createUser(login, secretHash) {
    const key = login.toLowerCase();
    const user = { login, hash: secretHash, createdAt: Date.now(), lastSeen: Date.now() };
    this.accounts.users[key] = user;
    await this.save("accounts");
    return user;
  }

  touchUser(login) {
    const user = this.getUser(login);
    if (!user) return;
    user.lastSeen = Date.now();
    this.save("accounts");
  }

  getConv(id) {
    return this.convs.convs[id] || null;
  }

  listConvs(login) {
    const key = login.toLowerCase();
    return Object.values(this.convs.convs)
      .filter((c) => c.id === GENERAL_ID || c.members.includes(key))
      .sort((a, b) => (a.id === GENERAL_ID ? -1 : b.createdAt - a.createdAt));
  }

  async createDm(login, other) {
    const a = login.toLowerCase();
    const b = other.toLowerCase();
    const id = "dm-" + crypto.createHash("sha1").update([a, b].sort().join(":")).digest("hex").slice(0, 20);
    if (this.convs.convs[id]) return this.convs.convs[id];
    const conv = {
      id,
      type: "dm",
      title: other,
      members: [a, b],
      shard: this.shards.current,
      createdAt: Date.now(),
    };
    this.convs.convs[id] = conv;
    await this.save("convs");
    return conv;
  }

  canAccess(conv, login) {
    if (!conv) return false;
    if (conv.id === GENERAL_ID) return true;
    return conv.members.includes(login.toLowerCase());
  }
}

export class Shards {
  constructor(registry, token, owner, prefix, thresholdKb) {
    this.registry = registry;
    this.token = token;
    this.owner = owner;
    this.prefix = prefix;
    this.thresholdKb = thresholdKb;
    this.growing = false;
    this.bytes = registry.shards.bytes || {};
  }

  addBytes(n, shard = this.current()) {
    this.bytes[shard] = (this.bytes[shard] || 0) + n;
    this.registry.shards.bytes = this.bytes;
  }

  name(n) {
    return `${this.prefix}${n}`;
  }

  repo(n) {
    return new GitHubRepo(this.owner, this.name(n), this.token);
  }

  current() {
    return this.registry.shards.current;
  }

  repoCurrent() {
    return this.repo(this.current());
  }

  async maybeGrow() {
    if (this.growing) return;
    this.growing = true;
    try {
      const currentShard = this.current();
      const apiSize = await this.repoCurrent().sizeKb().catch(() => 0);
      const localSize = Math.ceil((this.bytes[currentShard] || 0) / 1024);
      const size = Math.max(apiSize, localSize);
      if (size <= this.thresholdKb) return;
      const next = Math.max(...this.registry.shards.list) + 1;
      console.log(`[shards] repo ${this.name(currentShard)} is ${size}KB > ${this.thresholdKb}KB, creating ${this.name(next)}`);
      const created = await createRepo(this.token, this.owner, this.name(next), true);
      if (created === "exists") {
        console.log(`[shards] ${this.name(next)} already exists`);
      } else if (created !== true) {
        throw new Error(`Failed to create repo: ${created}`);
      }
      this.registry.shards.list.push(next);
      this.registry.shards.current = next;
      this.registry.shards.bytes = this.bytes;
      await this.registry.save("shards");
    } catch (err) {
      console.error("[shards] grow failed:", err.message);
    } finally {
      this.growing = false;
    }
  }
}

export class Messages {
  constructor(shards, registry, limit) {
    this.shards = shards;
    this.registry = registry;
    this.limit = limit;
    this.cache = new Map();
  }

  async load(convId) {
    if (this.cache.has(convId)) return this.cache.get(convId);
    const conv = this.registry.getConv(convId);
    const entry = { shard: conv?.shard || 1, messages: [], sha: null, dirty: false, timer: null, loading: null };
    entry.loading = (async () => {
      try {
        const file = await this.shards.repo(entry.shard).getFile(`msgs/${convId}.jsonl`);
        if (file) {
          entry.sha = file.sha;
          for (const line of file.data.toString("utf8").split("\n")) {
            if (!line.trim()) continue;
            try {
              entry.messages.push(JSON.parse(line));
            } catch {}
          }
        }
      } catch (err) {
        if (err.status !== 404) console.error(`[messages] load ${convId}:`, err.message);
      }
      if (entry.messages.length > 5000) entry.messages = entry.messages.slice(-5000);
    })();
    this.cache.set(convId, entry);
    await entry.loading;
    return entry;
  }

  async history(convId, limit) {
    const entry = await this.load(convId);
    const n = Math.max(1, Math.min(limit || this.limit, 1000));
    return entry.messages.slice(-n);
  }

  async append(convId, message) {
    const entry = await this.load(convId);
    entry.messages.push(message);
    if (entry.messages.length > 5000) entry.messages = entry.messages.slice(-5000);
    entry.dirty = true;
    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.flush(convId).catch((err) => console.error(`[messages] flush ${convId}:`, err.message));
      }, 2000);
      entry.timer.unref?.();
    }
  }

  async flush(convId) {
    const entry = this.cache.get(convId);
    if (!entry || !entry.dirty) return;
    entry.dirty = false;
    const content = entry.messages.map((m) => JSON.stringify(m)).join("\n") + (entry.messages.length ? "\n" : "");
    try {
      const repo = this.shards.repo(entry.shard);
      const res = await repo.putFile(`msgs/${convId}.jsonl`, content, `msgs: ${convId} (${entry.messages.length})`, entry.sha);
      entry.sha = res.sha;
      this.shards.addBytes(Buffer.byteLength(content), entry.shard);
    } catch (err) {
      entry.dirty = true;
      // If shard repo doesn't exist, try to grow and retry once
      if (err.status === 404) {
        await this.shards.maybeGrow();
        try {
          const repo = this.shards.repo(entry.shard);
          const res = await repo.putFile(`msgs/${convId}.jsonl`, content, `msgs: ${convId} (${entry.messages.length})`, entry.sha);
          entry.sha = res.sha;
          this.shards.addBytes(Buffer.byteLength(content), entry.shard);
        } catch (retryErr) {
          throw retryErr;
        }
      } else {
        throw err;
      }
    }
    this.shards.maybeGrow();
  }

  async flushAll() {
    for (const convId of this.cache.keys()) {
      try {
        await this.flush(convId);
      } catch {}
    }
  }
}

export class Files {
  constructor(shards, registry, chunkBytes, maxBytes) {
    this.shards = shards;
    this.registry = registry;
    this.chunkBytes = chunkBytes;
    this.maxBytes = maxBytes;
    this.uploads = new Map();
    setInterval(() => this.cleanup(), 3600_000).unref?.();
  }

  cleanup() {
    const cutoff = Date.now() - 3600_000;
    for (const [id, up] of this.uploads) if (up.createdAt < cutoff) this.uploads.delete(id);
  }

  start(login, { name, size, mime, convId }) {
    if (!Number.isFinite(size) || size <= 0) throw Object.assign(new Error("invalid size"), { status: 400 });
    if (size > this.maxBytes) throw Object.assign(new Error("file too large"), { status: 413 });
    const id = crypto.randomUUID();
    const chunks = Math.max(1, Math.ceil(size / this.chunkBytes));
    const shard = this.shards.current();
    this.uploads.set(id, {
      id,
      owner: login.toLowerCase(),
      name: String(name || "file").slice(0, 200),
      size,
      mime: mime || "application/octet-stream",
      convId,
      shard,
      chunks,
      parts: new Array(chunks).fill(null),
      createdAt: Date.now(),
    });
    return { id, chunks, chunkBytes: this.chunkBytes, shard };
  }

  getUpload(id, login) {
    const up = this.uploads.get(id);
    if (!up) throw Object.assign(new Error("upload not found"), { status: 404 });
    if (login && up.owner !== login.toLowerCase()) throw Object.assign(new Error("forbidden"), { status: 403 });
    return up;
  }

  async chunk(id, index, buffer, login) {
    const up = this.getUpload(id, login);
    if (index < 0 || index >= up.chunks) throw Object.assign(new Error("bad chunk"), { status: 400 });
    const sha = await this.shards.repo(up.shard).createBlob(buffer);
    up.parts[index] = sha;
    return { received: up.parts.filter(Boolean).length, chunks: up.chunks };
  }

  async complete(id, login) {
    const up = this.getUpload(id, login);
    if (up.parts.some((p) => !p)) throw Object.assign(new Error("missing chunks"), { status: 400 });
    const repo = this.shards.repo(up.shard);
    const entries = up.parts.map((sha, i) => ({
      path: `files/${up.id}/part-${String(i).padStart(4, "0")}`,
      mode: "100644",
      type: "blob",
      sha,
    }));
    let committed = false;
    for (let attempt = 0; attempt < 5 && !committed; attempt++) {
      try {
        const head = await repo.getHead();
        const commit = await repo.getCommit(head);
        const tree = await repo.createTree(commit.tree.sha, entries);
        const newCommit = await repo.createCommit(`file: ${up.name} (${up.size}B)`, tree, [head]);
        await repo.updateHead(newCommit);
        committed = true;
      } catch (err) {
        if (err.status === 404) {
          // Repo might not exist yet, try to create it
          await this.shards.maybeGrow();
        } else if (err.status !== 422 && err.status !== 409) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    if (!committed) throw Object.assign(new Error("commit conflict"), { status: 503 });

    const meta = {
      id: up.id,
      name: up.name,
      size: up.size,
      mime: up.mime,
      shard: up.shard,
      chunks: up.chunks,
      parts: up.parts,
      conv: up.convId,
      owner: up.owner,
      createdAt: Date.now(),
    };
    this.registry.files.files[up.id] = meta;
    await this.registry.save("files");
    this.uploads.delete(id);
    this.shards.addBytes(up.size, up.shard);
    this.shards.maybeGrow();
    return meta;
  }

  meta(id) {
    return this.registry.files.files[id] || null;
  }

  async chunkData(meta, index) {
    if (index < 0 || index >= meta.parts.length) throw Object.assign(new Error("bad chunk"), { status: 400 });
    return this.shards.repo(meta.shard).getBlobRaw(meta.parts[index]);
  }
}
