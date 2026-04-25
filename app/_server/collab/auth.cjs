const fs = require("fs");
const path = require("path");

const sessionsFilePath = path.join(
  process.cwd(),
  "data",
  "users",
  "sessions.json"
);

function readCollabSessions() {
  try {
    const content = fs.readFileSync(sessionsFilePath, "utf-8");
    return JSON.parse(content) || {};
  } catch {
    return {};
  }
}

function parseCollabCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx < 0) return;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    cookies[key] = val;
  });
  return cookies;
}

function authenticateCollab(request) {
  if (!request || !request.headers) return null;

  let cookieHeader = null;
  if (typeof request.headers.get === "function") {
    cookieHeader = request.headers.get("cookie");
  } else {
    cookieHeader = request.headers.cookie || null;
  }

  const cookies = parseCollabCookies(cookieHeader);
  const isHttps = process.env.HTTPS === "true";
  const sessionId = isHttps ? cookies["__Host-session"] : cookies["session"];

  if (!sessionId) return null;

  const sessions = readCollabSessions();
  const username = sessions[sessionId];
  return username || null;
}

const notesSharingFilePath = path.join(
  process.cwd(),
  "data",
  "notes",
  ".sharing.json"
);

function readNotesSharing() {
  try {
    const content = fs.readFileSync(notesSharingFilePath, "utf-8");
    return JSON.parse(content) || {};
  } catch {
    return null;
  }
}

/**
 * Determines whether `username` is allowed to access a Yjs document
 * identified by `documentName` (format: "<owner>/<category>/<noteId>").
 *
 * Owners always get access with role 'owner'. Otherwise we consult the
 * notes sharing JSON (`data/notes/.sharing.json`) and require canEdit
 * for collaborative access. Reads fresh from disk every call so revocations
 * propagate without cache invalidation.
 *
 * Returns: { allowed: boolean, role?: 'owner' | 'editor' | 'admin' }
 */
function canAccessDocument(username, documentName) {
  if (!username || !documentName) return { allowed: false };

  if (documentName.startsWith(`${username}/`)) {
    return { allowed: true, role: "owner" };
  }

  const parts = documentName.split("/");
  if (parts.length < 3) return { allowed: false };
  const owner = parts[0];
  const category = parts[1];
  const noteId = parts[2];

  const sharingData = readNotesSharing();
  if (!sharingData || typeof sharingData !== "object") {
    return { allowed: false };
  }

  const userShares = Array.isArray(sharingData[username])
    ? sharingData[username]
    : [];

  const entry = userShares.find((e) => {
    if (!e || e.sharer !== owner) return false;
    if (e.uuid && e.uuid === noteId) return true;
    if (e.id && e.id === noteId) {
      if (!e.category) return true;
      if (e.category === category) return true;
    }
    return false;
  });

  if (!entry) return { allowed: false };

  const perms = entry.permissions || {};
  if (perms.canEdit === true) {
    return {
      allowed: true,
      role: perms.canDelete === true ? "admin" : "editor",
    };
  }

  return { allowed: false };
}

module.exports = {
  authenticateCollab,
  readCollabSessions,
  parseCollabCookies,
  canAccessDocument,
};
