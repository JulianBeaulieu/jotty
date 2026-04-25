const crypto = require('crypto');

// Map of filePath -> { hash, ts }. Hash is computed over EXACTLY the bytes we
// wrote to disk. Callers that normalize line endings before write must pass
// the post-normalization content here so the hash compares against what
// chokidar will read back.
const recentSelfWrites = new Map();
const TTL_MS = 30000;

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function markSelfWrite(filePath, content) {
  recentSelfWrites.set(filePath, { hash: sha256(content), ts: Date.now() });
}

function wasSelfWrite(filePath, content) {
  const entry = recentSelfWrites.get(filePath);
  if (!entry) return false;
  if (Date.now() - entry.ts > TTL_MS) {
    recentSelfWrites.delete(filePath);
    return false;
  }
  if (entry.hash === sha256(content)) {
    recentSelfWrites.delete(filePath);
    return true;
  }
  return false;
}

function _clearAll() {
  recentSelfWrites.clear();
}

const reaper = setInterval(() => {
  const now = Date.now();
  for (const [path, entry] of recentSelfWrites.entries()) {
    if (now - entry.ts > TTL_MS) recentSelfWrites.delete(path);
  }
}, 5000);
reaper.unref();

module.exports = { markSelfWrite, wasSelfWrite, sha256, _clearAll };
