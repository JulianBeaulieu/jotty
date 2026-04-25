# Real-time Collaboration

> Status: **experimental**, gated behind `NEXT_PUBLIC_COLLAB_ENABLED`. Off by default.

This document covers the architecture, on-disk behaviour, and operational concerns of jotty's live collaboration feature. For the user-facing summary see the [README](../README.md#real-time-collaboration).

---

## Overview

`jotty·page` integrates [Yjs](https://yjs.dev) and [Hocuspocus](https://tiptap.dev/hocuspocus) into the existing TipTap rich-text editor so that multiple users can edit the same note live, with cursor presence. The Yjs CRDT lives in memory on the server; the on-disk `.md` file remains the source of truth and is updated on a debounced 2 second window.

What it covers:

- Shared, unencrypted notes opened in rich-text mode.
- Cursor presence with a deterministic per-user color.
- Offline durability on the client via IndexedDB (`y-indexeddb`).
- Reconciliation of external edits to the `.md` file (e.g. from an editor like nvim or Obsidian).

What it does **not** cover (MVP):

- Encrypted notes (server-side cannot decrypt without compromising the encryption model).
- Markdown-mode / minimal-mode editors.
- Checklists.
- Multi-process / HA (no Redis adapter yet).
- Avatars and richer presence beyond name + color.

---

## Enabling

1. Set the env var (server **and** client see this — it is `NEXT_PUBLIC_*`):

   ```bash
   NEXT_PUBLIC_COLLAB_ENABLED=true
   ```

2. Restart the custom Node server (`server.js`). The collab WebSocket endpoint is mounted at `/_ws/collab/`, alongside the existing `/_ws` invalidation channel.
3. Validate a session:
   - Open a shared note in two browsers.
   - Confirm the presence badge appears when two or more sessions are connected.
   - In the browser devtools, confirm a successful WebSocket upgrade against `wss://<host>/_ws/collab/<owner>/<category>/<noteId>`.

The flag short-circuits both the client hook (`useCollabProvider` returns nulls) and the server mount (the upgrade falls through to the existing `/_ws` channel) when off, so toggling it does not affect single-user behaviour.

---

## Architecture

```
Client TipTap + Collaboration ext + HocuspocusProvider + IndexeddbPersistence
    |
    | wss://host/_ws/collab/<owner>/<category>/<noteId>     (cookie auth)
    |
server.js  (custom Node)
    |--> /_ws         existing invalidation channel (unchanged)
    |--> /_ws/collab/  Hocuspocus  (this feature)
             |
             +-- onAuthenticate    auth.cjs        (sessions.json + sharing data)
             +-- onLoadDocument    persistence.cjs (md -> Y.Doc)
             +-- onStoreDocument   persistence.cjs (Y.Doc -> md, debounced 2s, lock-guarded write)
             +-- chokidar watcher  watcher.cjs    (sha256 echo suppression for self-writes)
             |
             +-> data/notes/<owner>/<category>/<noteId>.md   (still the source of truth)
```

The Hocuspocus instance is constructed lazily on first connection and held as a module-level singleton. The chokidar watcher starts at the same time and persists for the lifetime of the process.

---

## File map

| Path | Role |
|------|------|
| `app/_consts/collab.ts` | Client + isomorphic constants. Exports `COLLAB_ENABLED`, `COLLAB_WS_PATH`, `buildCollabUrl()`, `userColorFromName()`. |
| `app/_server/collab/server.cjs` | Hocuspocus singleton. Wires auth + load/store hooks, starts the fs watcher, bridges external changes into live `Y.Doc`s via `Y.applyUpdate(..., 'fs-sync')`. |
| `app/_server/collab/auth.cjs` | Cookie/session auth (`authenticateCollab`) plus `canAccessDocument` which consults `data/notes/.sharing.json` for cross-user access. |
| `app/_server/collab/persistence.cjs` | `onLoadDocument` (md -> Y.Doc, frontmatter cached on `document.context`) and `onStoreDocument` (Y.Doc -> md, lock-guarded atomic write, best-effort git commit). |
| `app/_server/collab/markdown.cjs` | Markdown <-> Y.Doc transformer plus `splitFrontmatter` / `joinFrontmatter` helpers. |
| `app/_server/collab/watcher.cjs` | Chokidar watcher that emits external-change events and exposes `computeReconciliationOps` (diffChars). |
| `app/_server/collab/echo-suppression.cjs` | sha256-based one-shot self-write filter with a 30 s TTL reaper. |
| `app/_hooks/useCollabProvider.tsx` | React hook that wires `HocuspocusProvider` + `IndexeddbPersistence` and exposes `{ ydoc, provider, status }`. |
| `app/_components/FeatureComponents/Notes/Parts/TipTap/EditorUtils/collabExtensions.ts` | `buildCollabExtensions({ ydoc, provider, username })` returning the `Collaboration` and `CollaborationCursor` TipTap extensions. |
| `app/_components/FeatureComponents/Notes/Parts/TipTap/CollabPresenceBadge.tsx` | "X people editing" UI affordance based on `provider.awareness.getStates()`. |

`server.js` adds a single upgrade branch (early-`return` before the existing `/_ws` branch) that decodes the document name from the URL and hands the socket to `collabServer.handleConnection`.

---

## Document name format

A document name is the path-form triplet:

```
<owner>/<category>/<noteId>
```

Examples:

- `alice/work/2025-04-24-standup-notes`
- `bob/personal/recipes`

The on-disk file resolves to `data/notes/<owner>/<category>/<noteId>.md` (see `resolveDocumentFilePath` in `persistence.cjs`).

The URL form is `/_ws/collab/<owner>/<category>/<noteId>` (path segments are `encodeURIComponent`'d on the client by `buildCollabUrl` callers).

---

## Persistence and durability

- **Debounce.** `Hocuspocus` is configured with `debounce: 2000` (ms) so a flurry of edits coalesces into a single store call.
- **Lock-guarded write.** `lockGuardedWrite` in `persistence.cjs` acquires a `proper-lockfile` on the directory (`realpath: false`, `stale: 5000`, exponential retries) before writing.
- **Atomic write.** Content is written to `<filePath>.tmp-<hex>` and then `fs.rename`d into place, so a partial write cannot truncate an existing file.
- **Self-write hash.** Before the write, `markSelfWrite(filePath, content)` records a sha256 over exactly the bytes that will land on disk. The watcher discards the next matching read.
- **Best-effort git commit.** `persistence.cjs` opportunistically requires `app/_server/actions/history` and calls `commitNote(...)`. Failures are swallowed (the TS module may not be requireable from CJS at runtime).
- **Client offline cache.** `useCollabProvider` wraps each `Y.Doc` with `IndexeddbPersistence(documentName, ydoc)` so unsynced edits survive page reloads and brief disconnects.

---

## Authentication and authorization

Authentication runs at two layers:

1. **HTTP upgrade layer (early reject).** `server.js` already runs `authenticateWs` against the cookie before deciding whether to upgrade. The same cookie applies to `/_ws/collab/`.
2. **Hocuspocus `onAuthenticate`.** `server.cjs` calls `authenticateCollab(request)` which:
   - reads the session cookie (`__Host-session` over HTTPS, `session` otherwise),
   - looks it up in `data/users/sessions.json`,
   - returns the username or `null`.

If no username is resolved, `onAuthenticate` throws `Unauthorized` and the connection is closed with the standard Y-protocol auth-denied message.

**Authorization.** The MVP `onAuthenticate` enforces ownership only: a user can join `<username>/...` documents but not someone else's namespace. `auth.cjs` exports `canAccessDocument(username, documentName)` that consults `data/notes/.sharing.json` and grants access to entries with `permissions.canEdit === true`. Wiring `canAccessDocument` into `onAuthenticate` is the next step for full shared-note collab.

---

## External edits (reconciliation)

The `.md` file remains a normal file on disk. Two cases:

- **No live session.** External edits are not reacted to. The next time a Hocuspocus session loads the document, `onLoadDocument` reads the new bytes — disk is authoritative.
- **Live session.** Chokidar fires a `change`/`add` event. `wasSelfWrite(filePath, content)` checks the sha256 against recently-marked self-writes and one-shot drops the matching entry. If it was not a self-write, `onExternalChange` runs:
  1. Resolve the live `Y.Doc` from `hocuspocus.documents.get(documentName)`.
  2. Refresh the cached frontmatter on `document.context`.
  3. If the new frontmatter has `encrypted: true`, mark `document.context.encryptedNote` and skip — the next store will refuse to persist.
  4. Build a fresh `Y.Doc` from the new body via `markdownToYDoc`, `Y.encodeStateAsUpdate(freshDoc)`, then `Y.applyUpdate(liveDoc, update, 'fs-sync')`.
  5. Destroy the temporary fresh `Y.Doc`.

**Coarse-merge limitation.** This is a "re-seed" rather than a structural three-way merge. Concurrent live typing and external edits will reconcile via Yjs CRDT semantics, but a pure markdown reformat that round-trips through ProseMirror can introduce no-op deltas. A proper three-way merge (lastFlushed / currentY / currentDisk) using `diff-match-patch` is on the roadmap.

---

## Encrypted notes

Encrypted notes are explicitly out of scope. `onLoadDocument` parses the YAML frontmatter and, if `encrypted: true`, sets `document.context.encryptedNote = true`, leaves the `Y.Doc` empty, and returns. `onStoreDocument` then **refuses to persist**, preventing an empty Y.Doc from clobbering the ciphertext on disk.

If a note is flipped to encrypted by an external write while a live session is open, the watcher path also marks the flag and skips reconciliation.

A rate-limited warning is logged to `[collab/persistence]` with a 60 s throttle per document.

---

## Markdown round-trip fidelity

The transformer (`markdown.cjs`) reuses the same HTML conversion pipeline the editor uses for single-user mode. Round-trip equivalence is asserted as: re-parse both sides through the same HTML pipeline and compare the resulting HTML (not byte-equality — whitespace will differ).

| Node type | Status |
|-----------|--------|
| Paragraphs, headings, bold/italic/strike, links | OK |
| Bullet and ordered lists, including nesting | OK |
| Task lists | OK |
| Tables (GFM) | OK |
| Code fences with language hint | OK |
| Frontmatter (YAML) | preserved verbatim (string, not re-serialised) |
| Mermaid, Drawio, Excalidraw, Callout, TagLink | degraded — round-trips imperfectly |

Fixture suite: `tests/collab/markdown-roundtrip.test.ts` (5 helper tests for `splitFrontmatter` / `joinFrontmatter` plus parametrised cases for the 10 fixtures under `tests/collab/fixtures/0[1-9]-*.md` and `10-mixed.md`).

The custom-node degradation is the largest known gap and is tracked under "Roadmap" below. Until it is addressed, notes that contain Mermaid / Drawio / Excalidraw / Callout / TagLink should be edited in single-user mode.

---

## Operations and troubleshooting

**Verify the upgrade hits Hocuspocus.** With a real session cookie:

```bash
wscat -c "ws://localhost:3000/_ws/collab/alice/work/note-1" \
      -H "Cookie: session=<your-session-id>"
```

You should see the Y-protocol handshake bytes immediately. If the connection closes with a 401-like message, `authenticateCollab` did not find the session.

**Logs to watch.** All collab logs are prefixed:

- `[collab]` — `server.cjs` watcher bridge.
- `[collab/persistence]` — load/store path, including the encrypted-note skip warning.
- `[collab/auth]` — (reserved, not yet emitting).

**"Reconciliation triggered by my own backend writes."** Symptom: every save triggers an external-change reconciliation against the live doc. Likely cause: a backend write path bypasses `markSelfWrite`. Audit:

- `app/_server/actions/file/index.ts` — `serverWriteFile` should be the choke point, and `lockGuardedWrite` already calls `markSelfWrite` for the collab-driven path. Any other code that writes a `.md` under `data/notes/` must also call `markSelfWrite(filePath, contentBytesAsWrittenToDisk)` **before** the write.
- The hash is computed against post-line-ending-normalisation bytes. If the writer normalises line endings after marking, the hash will not match.

**Lock contention.** `proper-lockfile` is configured with up to 30 retries (factor 1.2, 25 ms / 200 ms timeouts, 5 s stale). If you see write timeouts under heavy load, raise `stale` or check whether another process holds the directory lock.

**Multi-replica.** Not supported. Each Hocuspocus instance is a singleton with in-memory documents. Running two replicas against the same data directory will diverge — each replica will fight the other through the watcher path.

---

## Roadmap

- **Wire `canAccessDocument` into `onAuthenticate`** so editor-permission shares actually open in collab. Currently the gate is owner-only.
- **Three-way merge.** Replace the "re-seed via fresh Y.Doc + applyUpdate" reconciliation with a `diff-match-patch` three-way merge across `lastFlushed`, `currentY`, `currentDisk`.
- **Custom node attribute migration** so Mermaid, Drawio, Excalidraw, Callout, and TagLink round-trip cleanly through Yjs.
- **Encrypted-note collab.** Would require client-side decryption, plaintext Yjs session, and re-encryption at flush — non-trivial because the server must never see plaintext.
- **Multi-process / HA.** Wire the Hocuspocus Redis adapter for horizontal scaling.
- **Markdown-mode collab.** A separate `Y.Text`-only path without the ProseMirror schema for users who edit raw markdown.

---

## Verification commands

```bash
# Type check
yarn tsc --noEmit

# Tests
COREPACK_ENABLE_PROJECT_SPEC=0 yarn test:run tests/collab

# Lint
COREPACK_ENABLE_PROJECT_SPEC=0 yarn lint

# Manual end-to-end
NEXT_PUBLIC_COLLAB_ENABLED=true yarn dev
# Open the same shared note in two browsers, type in one, watch the other.
```
