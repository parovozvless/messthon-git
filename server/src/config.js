export const config = {
  port: Number(process.env.PORT || 3200),
  clientOrigin: process.env.CLIENT_ORIGIN || "*",
  jwtSecret: process.env.JWT_SECRET || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  owner: process.env.GITHUB_OWNER || "",
  registryRepo: process.env.REGISTRY_REPO || "messthon-data-1",
  shardPrefix: process.env.SHARD_PREFIX || "messthon-data-",
  shardThresholdKb: Number(process.env.SHARD_THRESHOLD_KB || 3 * 1024 * 1024),
  maxFileBytes: Number(process.env.MAX_FILE_BYTES || 1024 * 1024 * 1024),
  chunkBytes: Number(process.env.CHUNK_BYTES || 20 * 1024 * 1024),
  historyLimit: Number(process.env.HISTORY_LIMIT || 300),
};

export function assertConfig() {
  const missing = [];
  if (!config.githubToken) missing.push("GITHUB_TOKEN");
  if (!config.jwtSecret || config.jwtSecret.length < 32) missing.push("JWT_SECRET (32+ chars)");
  if (!config.owner) missing.push("GITHUB_OWNER");
  if (missing.length) throw new Error("Missing env: " + missing.join(", "));
}
