"use strict";

/**
 * 3-way merge helper for the collab fs <-> Y.Doc bridge.
 *
 * When an external markdown edit lands on disk while a Hocuspocus session is
 * live, we want to fold the disk-side changes into the Y.Doc without losing
 * concurrent in-memory typing. This module performs a string-level 3-way
 * merge using google's diff-match-patch:
 *
 *   base   = lastFlushedContent (what we wrote to disk last time)
 *   theirs = the new disk content (external edit)
 *   ours   = current Y.Doc rendered to markdown
 *
 * Strategy: build patches for base->theirs (the external delta) and apply them
 * to `ours`. patch_apply returns a per-patch boolean array; if any failed we
 * report `allApplied: false` so the caller can decide whether to fall back to
 * a coarser strategy (disk-wins).
 */

const DiffMatchPatch = require("diff-match-patch");

/**
 * @todo fccview is telling you to review this AI generated code
 * and make sure it's up to standards, reusable, modular and consistent with
 * the rest of the codebase.
 */
function threeWayMerge({ base, ours, theirs }) {
  const safeBase = typeof base === "string" ? base : "";
  const safeOurs = typeof ours === "string" ? ours : "";
  const safeTheirs = typeof theirs === "string" ? theirs : "";

  // Fast paths — avoid invoking dmp when one side has no changes.
  if (safeBase === safeTheirs) {
    return { merged: safeOurs, allApplied: true, results: [] };
  }
  if (safeBase === safeOurs) {
    return { merged: safeTheirs, allApplied: true, results: [] };
  }

  const dmp = new DiffMatchPatch();
  const theirPatches = dmp.patch_make(safeBase, safeTheirs);
  const [merged, results] = dmp.patch_apply(theirPatches, safeOurs);
  const allApplied = Array.isArray(results) && results.every(Boolean);

  return { merged, allApplied, results };
}

module.exports = { threeWayMerge };
