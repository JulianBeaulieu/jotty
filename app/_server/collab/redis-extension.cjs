"use strict";

/**
 * Optional Hocuspocus Redis extension factory for HA / multi-replica deployments.
 *
 * When COLLAB_REDIS_URL is set, returns a configured Redis extension instance
 * that lets multiple Jotty server replicas share Y.Doc updates and awareness
 * via Redis pub/sub. When the env var is unset/empty, returns null and the
 * collab server falls back to single-process behavior.
 *
 * TODO orchestrator: in getCollabServer(), call buildRedisExtensionIfEnabled()
 * and, if non-null, push it into the Hocuspocus `extensions: []` array
 * (e.g. `const redisExt = buildRedisExtensionIfEnabled(); if (redisExt) extensions.push(redisExt);`).
 */
function buildRedisExtensionIfEnabled() {
  const url = process.env.COLLAB_REDIS_URL;
  if (url === undefined || url === "") {
    return null;
  }

  try {
    const { Redis } = require("@hocuspocus/extension-redis");
    const parsed = new URL(url);
    return new Redis({
      host: parsed.hostname,
      port: parseInt(parsed.port || "6379", 10),
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      identifier:
        process.env.COLLAB_REDIS_INSTANCE_NAME || `jotty-${process.pid}`,
    });
  } catch (err) {
    console.warn(
      "[collab/redis] Failed to load redis extension; falling back to single-process:",
      err && err.message ? err.message : err
    );
    return null;
  }
}

module.exports = { buildRedisExtensionIfEnabled };
