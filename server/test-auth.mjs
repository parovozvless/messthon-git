const BASE = "http://127.0.0.1:3200";
const A = "torvalds";  // Real GitHub user
const sA = "a".repeat(48);
const res = await fetch(`${BASE}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ github: A, deviceSecret: sA }) });
const data = await res.json();
console.log("Auth:", res.status, data);
if (data.token) {
  const ws = new (await import("ws")).WebSocket(`ws://127.0.0.1:3200/ws?token=${data.token}`);
  ws.on("message", (raw) => { const p = JSON.parse(raw.toString()); console.log("WS:", p.type); if (p.type === "welcome") console.log("Welcome OK"); });
  ws.on("error", console.error);
  setTimeout(() => process.exit(0), 3000);
}
