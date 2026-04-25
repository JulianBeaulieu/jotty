# Real-time Collaboration Implementation Plan

> **For agentic workers:** Each agent owns a disjoint set of files. Do not edit files outside your ownership list. Use yarn (with `COREPACK_ENABLE_PROJECT_SPEC=0` env) for installs, but no further installs should be needed — all deps are already added.

**Goal:** Add Yjs + Hocuspocus-backed real-time collaborative editing to jotty's existing TipTap editor, persisting through the existing `.md` filesystem layout, reusing the existing `/_ws` cookie auth and the existing `simple-git` history.

**Architecture:** Hocuspocus server mounts on the existing custom Node `server.js` at path `/_ws/collab/:noteId`. It reuses `authenticateWs()` for cookie/session auth. On document load it reads the `.md` from disk, splits frontmatter (`gray-matter` style with `js-yaml` already in deps), and seeds a `Y.Doc` with a `Y.XmlFragment` named `"prosemirror"` (the binding y-prosemirror expects). On document store (debounced 2s) it serializes back to markdown, writes via `serverWriteFile` (now lock-guarded), and triggers the existing git-commit path. A `chokidar` watcher reconciles external edits to the same files using `diffChars`, with a sha256 echo-suppression hash to ignore self-writes. The client uses `@tiptap/extension-collaboration` + `@hocuspocus/provider` + `y-indexeddb`, gated behind `COLLAB_ENABLED` env var; falls back to existing single-user autosave path when off.

**Tech Stack:** `yjs`, `@hocuspocus/server`, `@hocuspocus/transformer`, `@hocuspocus/provider`, `@tiptap/extension-collaboration`, `@tiptap/extension-collaboration-cursor`, `y-indexeddb`, `y-prosemirror`, `chokidar`, plus existing `diff`, `proper-lockfile`, `js-yaml`, `simple-git`.

**Out of scope for MVP:** encrypted notes (skip; gate them out), markdown-mode (rich-mode only), checklists, multi-process/HA, presence avatars beyond cursor name+color.

---

## File Ownership Map (NO overlap between agents)

| Agent | Files (create / modify) |
|-------|---|
| **A — Lock prereq** | `app/_server/actions/file/index.ts:149-152` (modify), `tests/server-actions/file-lock.test.ts` (create) |
| **B — Server collab core** | `server.js` (modify; add `/_ws/collab/` upgrade dispatch), `app/_server/collab/server.ts` (create), `app/_server/collab/persistence.ts` (create), `app/_server/collab/auth.ts` (create — pure auth bridge, reads `data/users/sessions.json` like `server.js` does) |
| **C — Markdown ↔ YDoc** | `app/_server/collab/markdown.ts` (create), `tests/collab/markdown-roundtrip.test.ts` (create) |
| **D — FS watcher + reconcile** | `app/_server/collab/watcher.ts` (create), `app/_server/collab/echo-suppression.ts` (create), `tests/collab/watcher.test.ts` (create) |
| **E — Client editor wiring** | `app/_hooks/useCollabProvider.tsx` (create), `app/_components/FeatureComponents/Notes/Parts/TipTap/EditorUtils/editorConfig.ts` (modify; conditional extension list), `app/_components/FeatureComponents/Notes/Parts/TipTap/EditorUtils/collabExtensions.ts` (create), `app/_consts/collab.ts` (create — env flag), `.env.example` (modify) |

---

## Phase 1 — Parallel foundation (5 agents)

### Agent A — Lockfile prereq on `serverWriteFile`

**Files:**
- Modify: `app/_server/actions/file/index.ts` lines 149-152
- Create: `tests/server-actions/file-lock.test.ts`

**Implementation:**
- Wrap `serverWriteFile` body with `properLockfile.lock(filePath, { retries: { retries: 5, factor: 1.2, minTimeout: 25, maxTimeout: 200 }, realpath: false, stale: 5000 })`. If file does not exist yet, lockfile API has trouble (it locks the path). Use `realpath: false` so the lockfile sits beside a possibly-missing target. `await ensureDir(dirname)` BEFORE acquiring the lock. Release in `finally`. Atomic write: write to `${filePath}.tmp-${randomBytes}` then `fs.rename` so partial writes don't truncate.
- Test: spawn 10 parallel `serverWriteFile(samePath, 'A'.repeat(i))` calls, then read file — content must be one of the inputs in full, no interleaving, no truncation. Run on a tmp dir created with `fs.mkdtemp(os.tmpdir() + '/jotty-test-')`.

**Commit message:** `fix: serialize serverWriteFile with proper-lockfile to prevent concurrent-write data loss (#432)`

---

### Agent B — Server collab core (Hocuspocus mount on existing server.js)

**Files:**
- Modify: `server.js` — add a second WS upgrade branch for `/_ws/collab/`, calling Hocuspocus's `handleConnection`. Keep existing `/_ws` invalidation channel intact.
- Create: `app/_server/collab/server.ts` — exports `getCollabServer()` returning a singleton Hocuspocus `Server` instance configured with persistence + auth extensions. Uses `dynamic require` shape so plain Node `server.js` can `require('./.next/server/...')`-or actually since Next compiles TS, prefer placing this in a path that gets bundled. **Practical decision: implement `app/_server/collab/server.ts` as a TS module imported lazily in `server.js` via require of a small JS shim.** Create `lib/collab-server.js` (CommonJS shim) that imports from the compiled standalone build, OR — simpler — write `app/_server/collab/server.cjs` directly in CommonJS, using `require('@hocuspocus/server')`.
  - **Choose CommonJS shim approach** to avoid TS bundling chicken-and-egg with the custom server. Place at `app/_server/collab/server.cjs`. Document why in a top-of-file comment.
- Create: `app/_server/collab/auth.cjs` — exports `authenticateCollab(request, documentName)` returning `{ username }` or null. Mirror `authenticateWs` from `server.js` (read `data/users/sessions.json`, parse cookies, etc.). DRY note: extract shared cookie parser to a tiny module if trivial; otherwise duplicate (the bodies are short).
- Create: `app/_server/collab/persistence.cjs` — exports `{ onLoadDocument, onStoreDocument }` for Hocuspocus. `onLoadDocument({ documentName, document })`: parse `documentName` as `<username>/<category>/<noteId>`, resolve filesystem path via the same convention as `app/_consts/files.ts` `NOTES_DIR`. Read file → split frontmatter → call markdown→YDoc transform from Agent C's module (`require('./markdown.cjs')`). `onStoreDocument`: serialize YDoc → markdown → re-attach frontmatter → call lock-guarded `serverWriteFile` from Agent A's module → call existing `commitNote` from `app/_server/actions/history` (best-effort `try/catch`; log failures, don't crash). Debounce stores by 2000ms via Hocuspocus built-in `debounce` config.

**Hocuspocus mount in `server.js`:**
```js
// near top
const { getCollabServer } = require('./app/_server/collab/server.cjs');

// in upgrade handler, BEFORE the existing /_ws branch:
if (pathname && pathname.startsWith('/_ws/collab/')) {
  const collab = getCollabServer();
  const documentName = decodeURIComponent(pathname.slice('/_ws/collab/'.length));
  collab.handleConnection(req, socket, head, { documentName });
  return;
}
```

Hocuspocus's `Server.handleConnection` signature accepts `(request, socket, head, context)` — verify via `node_modules/@hocuspocus/server/dist/...` types if doc unclear. If signature differs, adapt.

**Commit message:** `feat(collab): mount Hocuspocus server on /_ws/collab/ with .md persistence hooks`

---

### Agent C — Markdown ↔ YDoc transformer + round-trip tests

**Files:**
- Create: `app/_server/collab/markdown.cjs` — exports `{ markdownToYDoc(markdown): Y.Doc, yDocToMarkdown(ydoc: Y.Doc): string, splitFrontmatter(raw): { frontmatter: object, body: string }, joinFrontmatter({frontmatter, body}): string }`.
- Create: `tests/collab/markdown-roundtrip.test.ts`

**Implementation:**
- Use `@hocuspocus/transformer` `TiptapTransformer.toYdoc(html, fragmentName='prosemirror', extensions)` — but Hocuspocus transformer wants HTML, not markdown. The pragmatic shape:
  - `splitFrontmatter`: regex `/^---\n([\s\S]*?)\n---\n([\s\S]*)$/`, parse YAML with `js-yaml.load`. If no frontmatter, return `{frontmatter: {}, body: raw}`.
  - `markdownToYDoc(md)`: convert md → HTML using the same path the existing editor uses (locate via `app/_components/FeatureComponents/Notes/Parts/TipTap/EditorUtils/processMarkdownContent` or equivalent — there's a `processMarkdownContent` referenced in `useNoteEditor.tsx`). Use that converter. Then `TiptapTransformer.toYdoc(html, 'prosemirror', extensionList)`. The `extensionList` must match the client's TipTap extensions exactly (this is the production hard part — for MVP, use the StarterKit subset and table/task-list/code-block, omit Mermaid/Drawio/Excalidraw/Callout/TagLink — those will round-trip imperfectly until later iterations).
  - `yDocToMarkdown(ydoc)`: `TiptapTransformer.fromYdoc(ydoc, 'prosemirror')` returns ProseMirror JSON, render to HTML via `prosemirror-model` Schema.parseSlice + DOMSerializer OR cheaper: use `@tiptap/core`'s `generateHTML(json, extensions)`. Then HTML → markdown via the existing `convertHtmlToMarkdownUnified` in jotty (locate it; it's referenced from `useNoteEditor.tsx`).
- Tests: a corpus of 10 fixture markdown strings (`tests/collab/fixtures/*.md`): plain text, headings, bullet list, nested list, code fence with lang, table, task list, frontmatter+body, mixed, edge case `# heading\n\n\n\nbody` (preserves blank lines acceptably). Each fixture must satisfy `markdownToYDoc → yDocToMarkdown` semantic equivalence. Define equivalence as: re-parse both through the same HTML pipeline and compare the resulting HTML. NOT byte equality (whitespace will differ).

**Note for Agent C:** Use Vitest (`yarn test:run tests/collab/markdown-roundtrip.test.ts`).

**Commit message:** `feat(collab): markdown ↔ Y.Doc transformer with round-trip fidelity tests`

---

### Agent D — Filesystem watcher with hash echo suppression

**Files:**
- Create: `app/_server/collab/watcher.cjs`
- Create: `app/_server/collab/echo-suppression.cjs`
- Create: `tests/collab/watcher.test.ts`

**Implementation:**
- `echo-suppression.cjs`: a Map<path, Set<sha256>> of recently-self-written content hashes. `markSelfWrite(path, content)` adds the sha256. `wasSelfWrite(path, content)` returns true and *removes* the hash on first match (one-shot). Also store a timestamp; reap entries older than 30s in a setInterval.
- `watcher.cjs`: `startWatcher({ rootDir, onExternalChange })`. Use `chokidar.watch(path.join(rootDir, '**/*.md'), { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }})`. On `change`/`add`: read file content; if `wasSelfWrite`, ignore; else `onExternalChange({ filePath, content })`.
- Wire into Hocuspocus persistence (Agent B will hook this up): when watcher reports an external change for a doc that has a live Hocuspocus session, compute `diffChars(currentYTextString, newDiskContent)` and apply as a Y transaction with `origin: 'fs-sync'`. If no live session, do nothing (next load will pick up disk content). For MVP **just the watcher emitting events** is enough; reconciliation can be a follow-up — but provide the diff helper here.
- Tests: write file via `serverWriteFile` after `markSelfWrite` → watcher must NOT fire `onExternalChange`. Write file via raw `fs.writeFile` → watcher MUST fire. Use a tmp dir; await `awaitWriteFinish` debounce explicitly with a 400ms timeout in test.

**Commit message:** `feat(collab): chokidar fs watcher with sha256 echo suppression for self-writes`

---

### Agent E — Client editor wiring (TipTap collab extensions + provider hook + flag)

**Files:**
- Create: `app/_consts/collab.ts` — exports `COLLAB_ENABLED = process.env.NEXT_PUBLIC_COLLAB_ENABLED === 'true'` and `COLLAB_WS_PATH = '/_ws/collab/'`.
- Modify: `.env.example` — add `NEXT_PUBLIC_COLLAB_ENABLED=false` with comment.
- Create: `app/_hooks/useCollabProvider.tsx` — React hook `useCollabProvider({ documentName, enabled })`. When `enabled` is false, return `{ provider: null, ydoc: null }`. When true, build URL `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/_ws/collab/${encodeURIComponent(documentName)}`. Instantiate `HocuspocusProvider({ url: <base wss url>, name: documentName, document: new Y.Doc() })`. Wrap with `IndexeddbPersistence(documentName, ydoc)` from `y-indexeddb` for offline durability. Cleanup: `provider.destroy()`, `idb.destroy()` on unmount. Return `{ provider, ydoc, status }` where status reflects connection state via `provider.on('status', ...)`.
- Create: `app/_components/FeatureComponents/Notes/Parts/TipTap/EditorUtils/collabExtensions.ts` — exports `buildCollabExtensions({ ydoc, provider, user })` returning an array with `Collaboration.configure({ document: ydoc, fragment: ydoc.getXmlFragment('prosemirror') })` and `CollaborationCursor.configure({ provider, user: { name: user.username, color: deterministicColorFromUsername(user.username) } })`. Color helper: hash username → HSL hue.
- Modify: `app/_components/FeatureComponents/Notes/Parts/TipTap/EditorUtils/editorConfig.ts` — accept new optional param `collabExtensions?: Extension[]`. When provided, **disable history** (CollaborationCaret/Yjs manages it) — find the StarterKit config and pass `{ history: false }`. Append `collabExtensions` to the returned extension list. Default behavior unchanged when param omitted.
- **DO NOT** modify `useNoteEditor.tsx` directly — leave that for Phase 2 integration. Instead, document the integration point at the top of `useCollabProvider.tsx` JSDoc.

**Commit message:** `feat(collab): client-side Yjs provider hook + TipTap collab extensions (gated by NEXT_PUBLIC_COLLAB_ENABLED)`

---

## Phase 2 — Sequential integration (after Phase 1)

This is for the orchestrator (me) after agents return:

1. Wire `useCollabProvider` into `useNoteEditor.tsx`: when `COLLAB_ENABLED && note.isShared && !note.encrypted && !markdownMode`, swap autosave path for the Yjs provider, pass `collabExtensions` into editor.
2. Connect Agent D's watcher to Agent B's Hocuspocus document registry so external `.md` edits propagate into live Y.Docs.
3. Add `markSelfWrite` calls in Agent A's `serverWriteFile` (or wrap it) so the watcher's echo suppression actually fires.
4. Add a small UI affordance: "X people editing" badge (use `provider.awareness.getStates()`).
5. README + docs/COLLAB.md: enable instructions, known limitations.

---

## Phase 3 (out of scope but documented for future)

- Custom NodeView audit for Mermaid/Drawio/Excalidraw/Callout/TagLink (their attributes must be Yjs-safe).
- Encrypted-note support (decrypt at session open, re-encrypt at flush).
- Markdown-mode collab (likely separate Y.Text without ProseMirror schema).
- Multi-process / HA (Hocuspocus Redis adapter).
- True 3-way merge (lastFlushed, currentY, currentDisk) with diff-match-patch — the genuine novel opportunity flagged in research synthesis.

---

## Verification commands

```bash
# Type check
yarn tsc --noEmit

# Tests
COREPACK_ENABLE_PROJECT_SPEC=0 yarn test:run

# Lint
COREPACK_ENABLE_PROJECT_SPEC=0 yarn lint

# Manual E2E (after Phase 2):
NEXT_PUBLIC_COLLAB_ENABLED=true yarn dev
# Open same note in two browsers, type in one, watch the other.
```
