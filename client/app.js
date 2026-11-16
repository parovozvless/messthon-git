"use strict";

const API = new URLSearchParams(location.search).get("api") || "https://messthon-git.onrender.com";
const WS_URL = API.replace(/^http/, "ws") + "/ws";

const state = {
  token: localStorage.getItem("messthon.token") || "",
  login: localStorage.getItem("messthon.login") || "",
  secret: localStorage.getItem("messthon.secret") || "",
  conversations: [],
  current: "general",
  messages: [],
  online: [],
  ws: null,
  retry: 1000,
  reconnectTimer: null,
  reconnectAttempts: 0,
  connecting: false,
  typingSent: 0,
  pendingFile: null,
  uploading: false,
};

const $ = (id) => document.getElementById(id);
const loginView = $("loginView");
const appView = $("appView");
const loginInput = $("loginInput");
const loginBtn = $("loginBtn");
const loginError = $("loginError");
const convList = $("convList");
const convTitle = $("convTitle");
const onlineLabel = $("onlineLabel");
const messagesEl = $("messages");
const messageInput = $("messageInput");
const sendBtn = $("sendBtn");
const fileInput = $("fileInput");
const uploadBar = $("uploadBar");
const uploadText = $("uploadText");
const uploadFill = $("uploadFill");
const meLabel = $("meLabel");
const logoutBtn = $("logoutBtn");
const newDmBtn = $("newDmBtn");
const dmModal = $("dmModal");
const dmInput = $("dmInput");
const dmError = $("dmError");
const dmStart = $("dmStart");
const dmCancel = $("dmCancel");

function esc(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function randomSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(API + path, { ...options, headers });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const error = data?.error || `HTTP_${res.status}`;
    const err = new Error(error);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- auth ---------- */
async function doLogin() {
  const github = loginInput.value.trim();
  loginError.textContent = "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(github)) {
    loginError.textContent = "Enter a valid GitHub username.";
    return;
  }
  if (!state.secret) {
    state.secret = randomSecret();
    localStorage.setItem("messthon.secret", state.secret);
  }
  loginBtn.disabled = true;
  loginBtn.textContent = "Signing in...";
  try {
    const data = await api("/api/auth", {
      method: "POST",
      body: { github, deviceSecret: state.secret },
    });
    state.token = data.token;
    state.login = data.login;
    localStorage.setItem("messthon.token", data.token);
    localStorage.setItem("messthon.login", data.login);
    showApp();
    await loadConversations();
    connect();
  } catch (err) {
    const map = {
      GITHUB_USER_NOT_FOUND: "No such GitHub user.",
      LOGIN_TAKEN_BY_OTHER_DEVICE: "This username is bound to another browser.",
      INVALID_GITHUB_LOGIN: "Enter a valid GitHub username.",
      RATE_LIMIT: "Too many attempts. Wait a minute.",
    };
    loginError.textContent = map[err.message] || "Sign in failed: " + err.message;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Continue";
  }
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  meLabel.textContent = state.login;
}

function logout() {
  localStorage.removeItem("messthon.token");
  localStorage.removeItem("messthon.login");
  state.token = "";
  state.login = "";
  state.conversations = [];
  state.messages = [];
  state.current = "general";
  if (state.ws) state.ws.close();
  state.ws = null;
  appView.hidden = true;
  loginView.hidden = false;
  loginInput.value = "";
}

/* ---------- conversations ---------- */
async function loadConversations() {
  const data = await api("/api/conversations");
  state.conversations = data.conversations || [];
  renderConversations();
  const current = state.conversations.find((c) => c.id === state.current);
  if (!current && state.conversations.length) state.current = state.conversations[0].id;
  await selectConversation(state.current, true);
}

function renderConversations() {
  convList.innerHTML = state.conversations
    .map((conv) => {
      const label = conv.id === "general" ? "general" : conv.title;
      const type = conv.id === "general" ? "room" : "direct message";
      return `<button class="conv ${conv.id === state.current ? "active" : ""}" data-id="${esc(conv.id)}">
        <span class="conv-name">${esc(label)}</span>
        <span class="conv-type">${esc(type)}</span>
      </button>`;
    })
    .join("");
  for (const el of convList.querySelectorAll(".conv")) {
    el.addEventListener("click", () => selectConversation(el.dataset.id));
  }
}

async function selectConversation(id, render = true) {
  state.current = id;
  const conv = state.conversations.find((c) => c.id === id);
  convTitle.textContent = conv ? (conv.id === "general" ? "general" : conv.title) : id;
  renderConversations();
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(id)}/messages?limit=300`);
    state.messages = data.messages || [];
  } catch {
    state.messages = [];
  }
  if (render) renderMessages(true);
  messageInput.focus();
}

/* ---------- messages ---------- */
function renderMessages(scroll = false) {
  if (!state.messages.length) {
    messagesEl.innerHTML = '<div class="empty">No messages yet.</div>';
    return;
  }
  messagesEl.innerHTML = state.messages
    .map((m) => {
      const initial = esc((m.from || "?")[0]);
      const file = m.file
        ? `<div class="msg-file">
             <div>
               <div class="file-name">${esc(m.file.name)}</div>
               <div class="file-size">${fmtSize(m.file.size)}</div>
             </div>
             <button class="btn small" data-download="${esc(m.file.id)}">Download</button>
           </div>`
        : "";
      return `<div class="message">
        <div class="avatar">${initial}</div>
        <div class="msg-body">
          <div class="msg-head">
            <span class="msg-from">${esc(m.from)}</span>
            <span class="msg-time">${fmtTime(m.ts)}</span>
          </div>
          ${m.text ? `<div class="msg-text">${esc(m.text)}</div>` : ""}
          ${file}
        </div>
      </div>`;
    })
    .join("");
  for (const btn of messagesEl.querySelectorAll("[data-download]")) {
    btn.addEventListener("click", () => downloadFile(btn.dataset.download, btn));
  }
  if (scroll) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendMessage(message) {
  if (message.conversationId && message.conversationId !== state.current) return;
  state.messages.push(message);
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  renderMessages(false);
  if (nearBottom || message.from === state.login) messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendMessage() {
  if (state.uploading) return;
  const text = messageInput.value.trim();
  if (!text && !state.pendingFile) return;
  const payload = { type: "msg", conversationId: state.current, text };
  if (state.pendingFile) payload.fileId = state.pendingFile.id;

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  } else {
    await api(`/api/conversations/${encodeURIComponent(state.current)}/messages`, {
      method: "POST",
      body: { text, fileId: state.pendingFile?.id },
    });
  }
  messageInput.value = "";
  messageInput.style.height = "auto";
  if (state.pendingFile) {
    state.pendingFile = null;
    fileInput.value = "";
    uploadBar.hidden = true;
  }
}

/* ---------- files ---------- */
async function uploadFile(file) {
  if (state.uploading) return;
  if (file.size > 1024 * 1024 * 1024) {
    alert("File is larger than 1 GB.");
    return;
  }
  state.uploading = true;
  uploadBar.hidden = false;
  uploadFill.style.width = "0%";
  uploadText.textContent = `Uploading ${file.name} (${fmtSize(file.size)})`;
  try {
    const start = await api("/api/files/start", {
      method: "POST",
      body: {
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        convId: state.current,
      },
    });
    for (let index = 0; index < start.chunks; index++) {
      const from = index * start.chunkBytes;
      const to = Math.min(file.size, from + start.chunkBytes);
      const buffer = await file.slice(from, to).arrayBuffer();
      await api(`/api/files/${start.id}/chunk?index=${index}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: buffer,
      });
      const pct = Math.round(((index + 1) / start.chunks) * 95);
      uploadFill.style.width = pct + "%";
      uploadText.textContent = `Uploading ${file.name} — ${pct}%`;
    }
    const done = await api(`/api/files/${start.id}/complete`, { method: "POST" });
    state.pendingFile = done.file;
    uploadFill.style.width = "100%";
    uploadText.textContent = `${done.file.name} attached — press Send`;
  } catch (err) {
    uploadText.textContent = "Upload failed: " + err.message;
    state.pendingFile = null;
  } finally {
    state.uploading = false;
  }
}

async function downloadFile(id, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Loading...";
  try {
    const meta = await api(`/api/files/${id}/meta`);
    const chunks = [];
    for (let i = 0; i < meta.file.chunks; i++) {
      const res = await fetch(`${API}/api/files/${id}/chunk/${i}`, {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (!res.ok) throw new Error("chunk failed");
      chunks.push(await res.arrayBuffer());
      button.textContent = `Loading ${Math.round(((i + 1) / meta.file.chunks) * 100)}%`;
    }
    const blob = new Blob(chunks, { type: meta.file.mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = meta.file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch {
    alert("Download failed.");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* ---------- websocket ---------- */
function connect() {
  if (!state.token || state.connecting) return;
  if (state.ws) {
    try { state.ws.close(); } catch {}
  }
  state.connecting = true;
  const url = `${WS_URL}?token=${encodeURIComponent(state.token)}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    state.connecting = false;
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    state.connecting = false;
    state.retry = 1000;
    state.reconnectAttempts = 0;
    clearTimeout(state.reconnectTimer);
    updateConnectionStatus(true);
  };

  ws.onmessage = (event) => {
    let packet;
    try { packet = JSON.parse(event.data); } catch { return; }
    if (packet.type === "welcome") {
      state.online = packet.online || [];
      state.conversations = packet.conversations || state.conversations;
      renderConversations();
      renderOnline();
      return;
    }
    if (packet.type === "msg") {
      appendMessage({ ...packet.message, conversationId: packet.conversationId });
      return;
    }
    if (packet.type === "presence") {
      state.online = packet.online || [];
      renderOnline();
      return;
    }
    if (packet.type === "typing" && packet.conversationId === state.current) {
      onlineLabel.textContent = `${packet.login} is typing...`;
      clearTimeout(connect._typingTimer);
      connect._typingTimer = setTimeout(renderOnline, 2500);
      return;
    }
    if (packet.type === "error") {
      onlineLabel.textContent = packet.error || "Error";
    }
  };

  ws.onclose = () => {
    state.connecting = false;
    if (!state.token) return;
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

function scheduleReconnect() {
  if (state.reconnectTimer || state.connecting) return;
  const delay = Math.min(1000 * 2 ** Math.min((state.reconnectAttempts || 0), 5), 30000);
  state.reconnectAttempts = (state.reconnectAttempts || 0) + 1;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, delay);
  updateConnectionStatus(false);
}


function updateConnectionStatus(connected) {
  const indicator = document.getElementById('connectionIndicator');
  if (indicator) {
    indicator.textContent = connected ? '🟢' : '🔴';
    indicator.title = connected ? 'Connected' : 'Disconnected - reconnecting...';
  }
}

function updateConnectionStatus(connected) {
  const indicator = document.getElementById('connectionIndicator');
  if (indicator) {
    indicator.textContent = connected ? '🟢' : '🔴';
    indicator.title = connected ? 'Connected' : 'Disconnected - reconnecting...';
  }
}

function renderOnline() {
  const n = state.online.length;
  onlineLabel.textContent = n ? `${n} online` : "";
  updateConnectionStatus(true);
  updateConnectionStatus(true);
}

/* ---------- events ---------- */
loginBtn.addEventListener("click", doLogin);
loginInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
logoutBtn.addEventListener("click", logout);

sendBtn.addEventListener("click", sendMessage);
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 140) + "px";
  const now = Date.now();
  if (state.ws?.readyState === WebSocket.OPEN && now - state.typingSent > 2500) {
    state.typingSent = now;
    state.ws.send(JSON.stringify({ type: "typing", conversationId: state.current }));
  }
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) uploadFile(file);
});

newDmBtn.addEventListener("click", () => {
  dmModal.hidden = false;
  dmError.textContent = "";
  dmInput.value = "";
  dmInput.focus();
});
dmCancel.addEventListener("click", () => (dmModal.hidden = true));
dmStart.addEventListener("click", async () => {
  const withLogin = dmInput.value.trim();
  dmError.textContent = "";
  try {
    const data = await api("/api/conversations", { method: "POST", body: { with: withLogin } });
    const conv = data.conversation;
    if (!state.conversations.some((c) => c.id === conv.id)) state.conversations.push(conv);
    dmModal.hidden = true;
    renderConversations();
    await selectConversation(conv.id);
  } catch (err) {
    const map = {
      USER_NOT_REGISTERED: "This GitHub user is not registered here.",
      SELF_DM: "You cannot message yourself.",
      INVALID_LOGIN: "Enter a valid GitHub username.",
    };
    dmError.textContent = map[err.message] || err.message;
  }
});
dmInput.addEventListener("keydown", (e) => { if (e.key === "Enter") dmStart.click(); });

/* ---------- boot ---------- */
(function boot() {
  if (!state.secret) {
    state.secret = randomSecret();
    localStorage.setItem("messthon.secret", state.secret);
  }
  if (state.token && state.login) {
    showApp();
    loadConversations()
      .then(connect)
      .catch(() => logout());
  } else {
    loginView.hidden = false;
    loginInput.focus();
  }
})();
