const API = "https://api.github.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GitHubRepo {
  constructor(owner, repo, token) {
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.base = `${API}/repos/${owner}/${repo}`;
  }

  headers(accept = "application/vnd.github+json") {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "messthon-git",
    };
  }

  async request(method, path, { body, accept, retries = 3 } = {}) {
    const url = `${this.base}${path}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          ...this.headers(accept),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
      if (retryable && attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after") || 0);
        const wait = retryAfter ? retryAfter * 1000 : 600 * (attempt + 1);
        await sleep(Math.min(wait, 8000));
        continue;
      }
      const err = new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
  }

  async getFile(path) {
    const res = await this.request("GET", `/contents/${encodePath(path)}`);
    const json = await res.json();
    if (Array.isArray(json)) throw new Error(`${path} is a directory`);
    let data;
    if (json.content) {
      data = Buffer.from(json.content, json.encoding || "base64");
    } else {
      data = await this.getRaw(path);
    }
    return { data, sha: json.sha };
  }

  async getJson(path) {
    const file = await this.getFile(path);
    return file ? { data: JSON.parse(file.data.toString("utf8") || "{}"), sha: file.sha } : null;
  }

  async getRaw(path) {
    const res = await this.request("GET", `/contents/${encodePath(path)}`, { accept: "application/vnd.github.raw" });
    return Buffer.from(await res.arrayBuffer());
  }

  async putFile(path, content, message, sha = null) {
    const body = {
      message,
      content: Buffer.isBuffer(content) ? content.toString("base64") : Buffer.from(content, "utf8").toString("base64"),
    };
    if (sha) body.sha = sha;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await this.request("PUT", `/contents/${encodePath(path)}`, { body });
        const json = await res.json();
        return { sha: json.content?.sha || null };
      } catch (err) {
        if ((err.status === 409 || err.status === 422) && attempt < 3) {
          try {
            const fresh = await this.getFile(path);
            if (fresh?.sha) body.sha = fresh.sha;
            else delete body.sha;
          } catch {
            delete body.sha;
          }
          await sleep(250 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`putFile ${path} failed after retries`);
  }

  async deleteFile(path, sha, message) {
    await this.request("DELETE", `/contents/${encodePath(path)}`, { body: { message, sha } });
  }

  async listDir(path) {
    const res = await this.request("GET", `/contents/${encodePath(path)}`);
    const json = await res.json();
    return Array.isArray(json) ? json : null;
  }

  async sizeKb() {
    const res = await fetch(`${this.base}`, { headers: this.headers() });
    if (!res.ok) return 0;
    const json = await res.json();
    return json.size || 0;
  }

  async createBlob(buffer) {
    const res = await this.request("POST", "/git/blobs", {
      body: { content: Buffer.from(buffer).toString("base64"), encoding: "base64" },
    });
    return (await res.json()).sha;
  }

  async getBlobRaw(sha) {
    const res = await this.request("GET", `/git/blobs/${sha}`, { accept: "application/vnd.github.raw" });
    return Buffer.from(await res.arrayBuffer());
  }

  async getHead() {
    const res = await this.request("GET", "/git/ref/heads/main");
    return (await res.json()).object.sha;
  }

  async getCommit(sha) {
    const res = await this.request("GET", `/git/commits/${sha}`);
    return res.json();
  }

  async createTree(baseTree, entries) {
    const res = await this.request("POST", "/git/trees", {
      body: { base_tree: baseTree, tree: entries },
    });
    return (await res.json()).sha;
  }

  async createCommit(message, tree, parents) {
    const res = await this.request("POST", "/git/commits", {
      body: { message, tree, parents },
    });
    return (await res.json()).sha;
  }

  async updateHead(sha) {
    await this.request("PATCH", "/git/refs/heads/main", { body: { sha, force: false } });
  }
}

export async function createRepo(token, owner, name, isPrivate) {
  const res = await fetch(`${API}/user/repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "messthon-git",
    },
    body: JSON.stringify({ name, private: isPrivate, auto_init: true, description: "messthon-git storage shard" }),
  });
  if (res.status === 201) return true;
  if (res.status === 422) return "exists";
  const text = await res.text();
  throw new Error(`createRepo ${name} -> ${res.status}: ${text.slice(0, 200)}`);
}

export async function githubUserExists(token, login) {
  const res = await fetch(`${API}/users/${encodeURIComponent(login)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "messthon-git" },
  });
  return res.ok;
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}
