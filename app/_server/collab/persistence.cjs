const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const yaml = require("js-yaml");

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

// Rate-limited warning state for encrypted-note skips.
// Key: documentName -> last warn timestamp (ms).
const _encryptedWarnLog = new Map();
const ENCRYPTED_WARN_THROTTLE_MS = 60_000;

function _maybeWarnEncrypted(documentName, action) {
  const now = Date.now();
  const last = _encryptedWarnLog.get(documentName) || 0;
  if (now - last < ENCRYPTED_WARN_THROTTLE_MS) return;
  _encryptedWarnLog.set(documentName, now);
  console.warn(
    `[collab/persistence] Encrypted note detected (${action}); skipping Y.Doc seeding/persistence to avoid clobbering ciphertext:`,
    documentName
  );
}

function _isEncryptedFrontmatter(frontmatterText) {
  if (!frontmatterText || typeof frontmatterText !== "string") return false;
  try {
    const parsed = yaml.load(frontmatterText);
    return !!(parsed && typeof parsed === "object" && parsed.encrypted);
  } catch (_err) {
    return false;
  }
}

function resolveDocumentFilePath(documentName) {
  // documentName format: "<username>/<category>/<noteId>"
  // Final on-disk path: "<cwd>/data/notes/<username>/<category>/<noteId>.md"
  return path.join(process.cwd(), "data", "notes", `${documentName}.md`);
}

function tryRequireMarkdownModule() {
  try {
    return require("./markdown.cjs");
  } catch (err) {
    console.warn(
      "[collab/persistence] markdown.cjs unavailable yet (Agent C):",
      err && err.message ? err.message : err
    );
    return null;
  }
}

async function lockGuardedWrite(filePath, content) {
  // Mark this content as a self-write so the chokidar watcher (Agent D) ignores
  // the resulting fs event. Done before the actual write so the marker is in
  // place by the time chokidar fires.
  try {
    const { markSelfWrite } = require("./echo-suppression.cjs");
    markSelfWrite(filePath, content);
  } catch {
    // echo-suppression module optional — watcher may not be running
  }

  let lockfile;
  try {
    lockfile = require("proper-lockfile");
  } catch {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content, "utf-8");
    return;
  }

  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });

  let release;
  try {
    release = await lockfile.lock(dir, {
      retries: { retries: 30, factor: 1.2, minTimeout: 25, maxTimeout: 200 },
      stale: 5000,
      realpath: false,
    });
    const crypto = require("crypto");
    const tmpPath = `${filePath}.tmp-${crypto.randomBytes(6).toString("hex")}`;
    await fsp.writeFile(tmpPath, content, "utf-8");
    await fsp.rename(tmpPath, filePath);
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        /* swallow */
      }
    }
  }
}

async function onLoadDocument({ context, documentName, document }) {
  try {
    const filePath = resolveDocumentFilePath(documentName);

    let raw = null;
    try {
      raw = await fsp.readFile(filePath, "utf-8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        // New / unwritten note — leave doc empty
        return;
      }
      throw err;
    }

    let frontmatter = "";
    let body = raw;
    const match = raw.match(FRONTMATTER_REGEX);
    if (match) {
      frontmatter = match[1];
      body = match[2];
    }

    // Cache frontmatter on the document context for re-attach in onStoreDocument
    if (!document.context) document.context = {};
    document.context.frontmatter = frontmatter;
    document.context.collabFilePath = filePath;

    // Mirror the connection-scoped collabMode (set by onAuthenticate) onto
    // document.context so the watcher / store path can read it without the
    // payload. Default: "rich" (existing behavior).
    const collabMode =
      (context && context.collabMode) ||
      (document.context && document.context.collabMode) ||
      "rich";
    document.context.collabMode = collabMode;

    // Encrypted-note guard: parse YAML frontmatter and detect `encrypted: true`.
    // If set, leave the Y.Doc empty AND mark the context so onStoreDocument
    // refuses to persist (prevents an empty/garbled Y.Doc from clobbering the
    // ciphertext on disk). Live collab is effectively disabled for these notes.
    const encryptedNote = _isEncryptedFrontmatter(frontmatter);
    document.context.encryptedNote = encryptedNote;
    if (encryptedNote) {
      _maybeWarnEncrypted(documentName, "load");
      return;
    }

    // Markdown-mode path: seed a single Y.Text("markdown-source") with the
    // raw body. No prosemirror transformer involvement — clients editing in
    // markdown mode bind directly to this shared text type.
    if (collabMode === "markdown") {
      try {
        const ytext = document.getText("markdown-source");
        if (ytext.length === 0 && typeof body === "string" && body.length > 0) {
          ytext.insert(0, body);
        }
      } catch (err) {
        console.warn(
          "[collab/persistence] markdown-mode seed failed for",
          documentName,
          err && err.message ? err.message : err
        );
      }
      return;
    }

    const markdown = tryRequireMarkdownModule();
    if (!markdown || typeof markdown.markdownToYDoc !== "function") {
      console.warn(
        "[collab/persistence] markdownToYDoc not available; leaving Y.Doc empty for",
        documentName
      );
      return;
    }

    try {
      await markdown.markdownToYDoc(body, document);
    } catch (err) {
      console.warn(
        "[collab/persistence] markdownToYDoc failed for",
        documentName,
        err && err.message ? err.message : err
      );
    }
  } catch (err) {
    console.error(
      "[collab/persistence] onLoadDocument error for",
      documentName,
      err
    );
  }
}

async function onStoreDocument({ context, documentName, document }) {
  try {
    // Encrypted-note guard: refuse to persist. If the load path detected an
    // encrypted on-disk file, the Y.Doc was intentionally left empty — writing
    // it back would clobber the ciphertext.
    if (document.context && document.context.encryptedNote) {
      _maybeWarnEncrypted(documentName, "store");
      return;
    }

    const filePath =
      (document.context && document.context.collabFilePath) ||
      resolveDocumentFilePath(documentName);

    const collabMode =
      (document.context && document.context.collabMode) ||
      (context && context.collabMode) ||
      "rich";

    let body = "";
    if (collabMode === "markdown") {
      // Markdown-mode: read the shared Y.Text directly. No transformer
      // involvement; the client is the source of canonical markdown bytes.
      try {
        body = document.getText("markdown-source").toString();
      } catch (err) {
        console.error(
          "[collab/persistence] markdown-mode read failed for",
          documentName,
          err && err.message ? err.message : err
        );
        return;
      }
    } else {
      const markdown = tryRequireMarkdownModule();
      if (!markdown || typeof markdown.yDocToMarkdown !== "function") {
        console.warn(
          "[collab/persistence] yDocToMarkdown not available; skipping persist for",
          documentName
        );
        return;
      }

      try {
        body = await markdown.yDocToMarkdown(document);
      } catch (err) {
        console.error(
          "[collab/persistence] yDocToMarkdown failed for",
          documentName,
          err && err.message ? err.message : err
        );
        return;
      }
    }

    const frontmatter =
      (document.context && document.context.frontmatter) || "";

    let serialized;
    if (frontmatter && frontmatter.trim().length > 0) {
      serialized = `---\n${frontmatter}\n---\n${body}`;
    } else {
      serialized = body;
    }

    await lockGuardedWrite(filePath, serialized);

    // Best-effort: try to commit via history module. May fail if TS path
    // can't be required from CJS at runtime — that is acceptable for MVP.
    try {
      const history = require("../actions/history");
      if (history && typeof history.commitNote === "function") {
        const username = documentName.split("/")[0];
        const relativePath = documentName
          .substring(username.length + 1)
          .concat(".md");
        // Fire-and-forget; ignore errors
        Promise.resolve(
          history.commitNote(username, relativePath, "update", "")
        ).catch(() => {});
      }
    } catch (err) {
      // Cannot require TS module from CJS — log once at debug level
      // (no action needed)
    }
  } catch (err) {
    console.error(
      "[collab/persistence] onStoreDocument error for",
      documentName,
      err
    );
  }
}

module.exports = {
  onLoadDocument,
  onStoreDocument,
  resolveDocumentFilePath,
};
