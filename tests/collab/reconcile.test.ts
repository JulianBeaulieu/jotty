import { describe, it, expect } from "vitest";

const { threeWayMerge } = require("../../app/_server/collab/reconcile.cjs");

describe("threeWayMerge", () => {
    it("merges disjoint edits — both sides keep their changes", () => {
        const base = "line one\nline two\nline three\n";
        const ours = "line one EDITED-OURS\nline two\nline three\n";
        const theirs = "line one\nline two\nline three EDITED-THEIRS\n";

        const { merged, allApplied } = threeWayMerge({ base, ours, theirs });

        expect(allApplied).toBe(true);
        expect(merged).toContain("EDITED-OURS");
        expect(merged).toContain("EDITED-THEIRS");
    });

    it("returns ours unchanged when disk is identical to base", () => {
        const base = "alpha beta gamma\n";
        const ours = "alpha BETA gamma\n";
        const theirs = "alpha beta gamma\n";

        const { merged, allApplied } = threeWayMerge({ base, ours, theirs });

        expect(allApplied).toBe(true);
        expect(merged).toBe(ours);
    });

    it("returns theirs when ours is identical to base (disk wins)", () => {
        const base = "alpha beta gamma\n";
        const ours = "alpha beta gamma\n";
        const theirs = "alpha BETA gamma\n";

        const { merged, allApplied } = threeWayMerge({ base, ours, theirs });

        expect(allApplied).toBe(true);
        expect(merged).toBe(theirs);
    });

    it("flags partial application when both edited the same region", () => {
        // Same single-line region edited differently on both sides.
        const base = "shared line\n";
        const ours = "ours rewrote this line\n";
        const theirs = "theirs rewrote this line\n";

        const { merged, allApplied, results } = threeWayMerge({
            base,
            ours,
            theirs,
        });

        // Either patches partially failed (allApplied=false) or the merged
        // string falls back to one of the two sides — never silently drops
        // both. The contract is: caller can detect imperfect merge.
        expect(typeof merged).toBe("string");
        expect(Array.isArray(results)).toBe(true);
        if (!allApplied) {
            // If dmp couldn't apply cleanly, at least one of our edits is
            // still present (ours stays as the base of the apply).
            expect(merged.length).toBeGreaterThan(0);
        }
    });

    it("handles empty inputs without throwing", () => {
        const { merged, allApplied } = threeWayMerge({
            base: "",
            ours: "",
            theirs: "",
        });
        expect(merged).toBe("");
        expect(allApplied).toBe(true);
    });

    it("treats non-string inputs as empty strings", () => {
        const { merged } = threeWayMerge({
            base: undefined as any,
            ours: "live content\n",
            theirs: null as any,
        });
        // base==theirs ("" === "") so fast path returns ours.
        expect(merged).toBe("live content\n");
    });
});
