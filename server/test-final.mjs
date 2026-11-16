import WebSocket from "ws";
import crypto from "node:crypto";
const BASE = "http://127.0.0.1:3200";
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${x ? " — " + x : ""}`); };

async function auth(github, secret) {
  const res = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ github, deviceSecret: secret }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const sA = "a".repeat(48), sB = "b".repeat(48);
const A = "torvalds";
const B = "octocat";
const a1 = await auth(A, "a".repeat(48));
check("register A (torvalds)", a1.status === 200, `status=${a1.status}`);
const tA = a1.body.token;
const a2 = await auth(B, "b".repeat(48));
check("register B (octocat)", a2.status === 200);
const tB = a2.body.token;

const H = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

// general message
const m1 = await fetch(`${BASE}/api/conversations/general/messages`, { method: "POST", headers: H(tA), body: JSON.stringify({ text: "hello from A" }) });
check("post general message", m1.status === 200);

// websocket realtime
const ws = new WebSocket(`ws://127.0.0.1:3200/ws?token=${tB}`);
const welcome = await new Promise((resolve, reject) => {
  ws.on("message", (raw) => { const p = JSON.parse(raw.toString()); if (p.type === "welcome") resolve(p); });
  ws.on("error", reject);
  setTimeout(() => reject(new Error("welcome timeout")), 5000);
});
check("ws welcome", welcome.login === B, welcome.online.join(","));

const received = new Promise((resolve, reject) => {
  ws.on("message", (raw) => { const p = JSON.parse(raw.toString()); if (p.type === "msg" && p.message.text === "ws realtime") resolve(p); });
  setTimeout(() => reject(new Error("msg timeout")), 5000);
});
await fetch(`${BASE}/api/conversations/general/messages`, { method: "POST", headers: H(tA), body: JSON.stringify({ text: "ws realtime" }) });
const got = await received;
check("ws realtime delivery", got.message.from === A);

// DM
const dm = await fetch(`${BASE}/api/conversations`, { method: "POST", headers: H(tB), body: JSON.stringify({ with: A }) });
const dmBody = await dm.json();
check("create DM", dm.status === 200 && dmBody.conversation.members.includes(A.toLowerCase()), dmBody.error || dmBody.conversation?.id);
const dmId = dmBody.conversation.id;
await fetch(`${BASE}/api/conversations/${dmId}/messages`, { method: "POST", headers: H(tB), body: JSON.stringify({ text: "dm secret" }) });
const hist = await (await fetch(`${BASE}/api/conversations/${dmId}/messages`, { headers: H(tA) })).json();
check("DM history visible to member", hist.messages.some((m) => m.text === "dm secret"));

// file upload 1 MiB
const payload = crypto.randomBytes(1024 * 1024);
const start = await (await fetch(`${BASE}/api/files/start`, { method: "POST", headers: H(tA), body: JSON.stringify({ name: "test.bin", size: payload.length, mime: "application/octet-stream", convId: "general" }) })).json();
check("file start", start.chunks === 1, `chunks=${start.chunks}`);
const put = await fetch(`${BASE}/api/files/${start.id}/chunk?index=0`, { method: "PUT", headers: { ...H(tA), "Content-Type": "application/octet-stream" }, body: payload });
check("file chunk upload", put.status === 200);
const comp = await (await fetch(`${BASE}/api/files/${start.id}/complete`, { method: "POST", headers: H(tA) })).json();
check("file complete", comp.file?.size === payload.length);
const meta = await (await fetch(`${BASE}/api/files/${start.id}/meta`, { headers: H(tA) })).json();
const dl = Buffer.from(await (await fetch(`${BASE}/api/files/${start.id}/chunk/0`, { headers: H(tA) })).arrayBuffer());
check("file download matches", crypto.createHash("sha256").update(dl).digest("hex") === crypto.createHash("sha256").update(payload).digest("hex"));

// message with file
const mf = await fetch(`${BASE}/api/conversations/general/messages`, { method: "POST", headers: H(tA), body: JSON.stringify({ text: "file attached", fileId: start.id }) });
check("message with file", mf.status === 200);

// wait for message flush
await new Promise((r) => setTimeout(r, 3000));
const health = await (await fetch(`${BASE}/health`)).json();
check("health check", health.ok === true, JSON.stringify(health.shards));

ws.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
