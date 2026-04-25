const path = require("path");
const Y = require("yjs");
const { Hocuspocus } = require("@hocuspocus/server");
const persistence = require("./persistence.cjs");
const { authenticateCollab, canAccessDocument } = require("./auth.cjs");
const { startWatcher } = require("./watcher.cjs");
const { splitFrontmatter, markdownToYDoc, yDocToMarkdown } = require("./markdown.cjs");
const { threeWayMerge } = require("./reconcile.cjs");
const { buildRedisExtensionIfEnabled } = require("./redis-extension.cjs");

let instance = null;
let watcherHandle = null;

// Per-document snapshot of the markdown body we last flushed to disk. Used
// as the `base` in 3-way merges when an external edit lands during a live
// session — without it we cannot tell which deltas the user introduced on
// disk vs. which were already there. Populated in onAfterStoreDocument /
// onAfterLoadDocument hooks.
// fccview is onto you!
const lastFlushedContent = new Map();

const NOTES_ROOT = path.join(process.cwd(), "data", "notes");

async function _captureFlushed(documentName, document) {
  try {
    if (!document) return;
    if (document.context && document.context.encryptedNote) return;
    const body = await yDocToMarkdown(document);
    lastFlushedContent.set(documentName, body);
  } catch (err) {
    // Non-fatal: a missed snapshot means the next external edit falls back
    // to coarse Yjs reconciliation, not data loss.
    console.warn(
      "[collab] Failed to capture lastFlushedContent for",
      documentName,
      err && err.message ? err.message : err
    );
  }
}

// Bridge: chokidar (filesystem) -> live Hocuspocus Y.Doc.
// The watcher already filters self-writes via wasSelfWrite, so this callback
// only fires for genuinely external edits.
//
// Reconciliation strategy (MVP, coarse): build a fresh Y.Doc from the new
// markdown body, encode it as a single update, and apply that update to the
// live Hocuspocus Document. Hocuspocus's Document extends Y.Doc, so
// Y.applyUpdate(liveDoc, update, origin) is the correct call. CRDT semantics
// merge concurrent typing with the disk-driven state without losing edits.
// Caveat: a pure reformat (semantically identical bytes round-tripped through
// markdown<->prosemirror) can introduce no-op deltas; acceptable for MVP.
function startCollabWatcher(hocuspocus) {
  return startWatcher({
    rootDir: NOTES_ROOT,
    onExternalChange: async ({ filePath, content, kind }) => {
      try {
        const rel = path.relative(NOTES_ROOT, filePath);
        if (rel.startsWith("..") || path.isAbsolute(rel)) return;
        if (!rel.endsWith(".md")) return;
        const documentName = rel.slice(0, -3).split(path.sep).join("/");

        const liveDoc = hocuspocus.documents && hocuspocus.documents.get
          ? hocuspocus.documents.get(documentName)
          : null;
        if (!liveDoc) return; // No live session — disk is authoritative.

        if (kind === "unlink") {
          console.warn(
            "[collab] External delete during live session ignored:",
            documentName
          );
          return;
        }

        const { frontmatter, body } = splitFrontmatter(content || "");

        // Refresh cached frontmatter on the live document. splitFrontmatter
        // returns a parsed object; persistence stores frontmatter as a raw
        // string so re-serialise via js-yaml-friendly path. We keep the
        // simple raw-regex string form here to stay consistent with
        // persistence.cjs (which reads `document.context.frontmatter` as a
        // raw YAML body string between the `---` fences).
        if (!liveDoc.context) liveDoc.context = {};
        const rawMatch = (content || "").match(
          /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
        );
        liveDoc.context.frontmatter = rawMatch ? rawMatch[1] : "";

        // Encrypted-note guard: if external edit flips note to encrypted, do
        // not seed the live doc with ciphertext-as-text. Mark the flag so the
        // next store skips persistence too.
        if (frontmatter && frontmatter.encrypted) {
          liveDoc.context.encryptedNote = true;
          console.warn(
            "[collab] External change marks note encrypted; skipping reconciliation:",
            documentName
          );
          return;
        }
        liveDoc.context.encryptedNote = false;

        // 3-way merge path: we know what we last wrote to disk
        // (`lastFlushedContent`), the current Y.Doc text (`ours`), and the
        // new on-disk text (`theirs`). Compute the delta the user typed on
        // disk and replay it onto the live document state. This preserves
        // simultaneous-region edits with much higher precision than a raw
        // Y.applyUpdate from a fresh doc.
        // fccview is onto you!
        const base = lastFlushedContent.get(documentName);
        const ours = await yDocToMarkdown(liveDoc).catch(() => null);

        let mergedBody = body;
        if (typeof base === "string" && typeof ours === "string") {
          const result = threeWayMerge({ base, ours, theirs: body });
          if (result.allApplied) {
            mergedBody = result.merged;
          } else {
            // Partial apply — both sides edited the same region. Disk wins
            // for safety (the user's intent on disk is explicit).
            console.warn(
              "[collab] 3-way merge partially failed; disk-wins fallback for",
              documentName
            );
            mergedBody = body;
          }
        }

        const freshDoc = await markdownToYDoc(mergedBody);
        try {
          const update = Y.encodeStateAsUpdate(freshDoc);
          Y.applyUpdate(liveDoc, update, "fs-sync");
        } finally {
          if (freshDoc && typeof freshDoc.destroy === "function") {
            freshDoc.destroy();
          }
        }

        // The live doc now reflects `mergedBody`; record that as the new
        // base so the next external edit diffs from this point.
        lastFlushedContent.set(documentName, mergedBody);
      } catch (err) {
        console.error(
          "[collab] External change reconciliation failed:",
          filePath,
          err && err.message ? err.message : err
        );
      }
    },
  });
}

function getCollabServer() {
  if (instance) return instance;

  // Build the extensions array. Redis extension is opt-in via COLLAB_REDIS_URL
  // for HA / multi-replica setups; absent the env var, single-process behavior.
  const extensions = [];
  try {
    const redisExt = buildRedisExtensionIfEnabled();
    if (redisExt) extensions.push(redisExt);
  } catch (err) {
    console.warn(
      "[collab] buildRedisExtensionIfEnabled threw; continuing without Redis:",
      err && err.message ? err.message : err
    );
  }

  // Helper: derive collab mode (rich vs. markdown) from the WS URL query
  // string. Used by onAuthenticate to seed connection context, and by
  // onConnect/onLoadDocument as a fallback to populate document.context.
  function _parseCollabMode(request) {
    try {
      const rawUrl =
        request && (request.url || (request.headers && request.headers.host))
          ? request.url || "/"
          : "/";
      const url = new URL(rawUrl, "http://localhost");
      if (url.searchParams.get("mode") === "markdown") return "markdown";
    } catch {
      // fall through to default
    }
    return "rich";
  }

  instance = new Hocuspocus({
    debounce: 2000,
    quiet: true,
    extensions,

    async onAuthenticate({ request, documentName }) {
      const username = authenticateCollab(request);
      if (!username) {
        throw new Error("Unauthorized");
      }

      const collabMode = _parseCollabMode(request);

      // Authorization: delegate to canAccessDocument so owners and users
      // with shared canEdit permissions can both collaborate. Defensive
      // fallback to strict own-namespace check if the helper is somehow
      // unavailable (older auth.cjs shape) — fail closed, never open.
      if (typeof canAccessDocument === "function") {
        const access = canAccessDocument(username, documentName);
        if (!access.allowed) {
          throw new Error("Forbidden: no access to document");
        }
        return { user: { username, role: access.role }, collabMode };
      }

      if (!documentName.startsWith(`${username}/`)) {
        throw new Error("Forbidden: cross-user collab not yet supported");
      }

      return { user: { username }, collabMode };
    },

    // Hocuspocus passes the auth-returned context to onLoadDocument as the
    // `context` payload field, but downstream code (watcher, persistence
    // store path) reads from `document.context`. Bridge it so collabMode is
    // visible everywhere a Document is.
    async onConnect({ context, documentName, instance: hp }) {
      try {
        if (!context) return;
        const liveDoc =
          hp && hp.documents && hp.documents.get
            ? hp.documents.get(documentName)
            : null;
        if (liveDoc) {
          if (!liveDoc.context) liveDoc.context = {};
          if (context.collabMode && !liveDoc.context.collabMode) {
            liveDoc.context.collabMode = context.collabMode;
          }
        }
      } catch {
        /* non-fatal */
      }
    },

    onLoadDocument: persistence.onLoadDocument,
    onStoreDocument: persistence.onStoreDocument,
  });

  // Register a side-extension that snapshots the markdown body each time a
  // document is loaded or stored. Hocuspocus runs every extension's hooks
  // for a given event, so this stacks cleanly alongside persistence.cjs.
  // fccview is onto you!
  try {
    if (
      instance.configuration &&
      Array.isArray(instance.configuration.extensions)
    ) {
      instance.configuration.extensions.push({
        async afterLoadDocument({ documentName, document }) {
          await _captureFlushed(documentName, document);
        },
        async afterStoreDocument({ documentName, document }) {
          await _captureFlushed(documentName, document);
        },
      });
    }
  } catch (err) {
    console.warn(
      "[collab] Failed to register lastFlushedContent hooks:",
      err && err.message ? err.message : err
    );
  }

  // Start the chokidar -> Y.Doc bridge once, after the Hocuspocus instance
  // exists so the closure can resolve live documents by name.
  if (!watcherHandle) {
    try {
      watcherHandle = startCollabWatcher(instance);
    } catch (err) {
      console.warn(
        "[collab] Failed to start fs watcher:",
        err && err.message ? err.message : err
      );
    }
  }

  return instance;
}

module.exports = { getCollabServer };
