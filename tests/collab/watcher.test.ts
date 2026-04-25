import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "path";
import * as os from "os";

vi.unmock("fs/promises");
vi.unmock("fs");
vi.unmock("node:fs/promises");
vi.unmock("node:fs");

const realFs = await vi.importActual<typeof import("fs/promises")>("node:fs/promises");

const echo = require("../../app/_server/collab/echo-suppression.cjs");
const { startWatcher } = require("../../app/_server/collab/watcher.cjs");

type ChangeEvent = {
    filePath: string;
    content: string | null;
    kind: "add" | "change" | "unlink";
};

const STABILITY_WAIT = 600;

function createCollector() {
    const events: ChangeEvent[] = [];
    const callback = (e: ChangeEvent) => {
        events.push(e);
    };
    return { events, callback };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("collab watcher", () => {
    let tmpDir: string;
    let stopFn: (() => Promise<void> | void) | null = null;

    beforeEach(async () => {
        echo._clearAll();
        const raw = await realFs.mkdtemp(path.join(os.tmpdir(), "jotty-watcher-"));
        // macOS /tmp is a symlink to /private/tmp; chokidar emits realpath events
        tmpDir = await realFs.realpath(raw);
    });

    afterEach(async () => {
        if (stopFn) {
            await stopFn();
            stopFn = null;
        }
        try {
            await realFs.rm(tmpDir, { recursive: true, force: true });
        } catch {
            // best effort
        }
        vi.useRealTimers();
    });

    it("fires onExternalChange when an external write creates a new file", async () => {
        const { events, callback } = createCollector();
        const w = startWatcher({ rootDir: tmpDir, onExternalChange: callback });
        stopFn = w.stop;

        await delay(300);

        const filePath = path.join(tmpDir, "foo.md");
        await realFs.writeFile(filePath, "hello");

        await delay(STABILITY_WAIT);

        expect(events.length).toBeGreaterThanOrEqual(1);
        const evt = events[0];
        expect(evt.kind).toBe("add");
        expect(evt.content).toBe("hello");
    });

    it("suppresses callback when a self-write is marked first", async () => {
        const { events, callback } = createCollector();
        const w = startWatcher({ rootDir: tmpDir, onExternalChange: callback });
        stopFn = w.stop;

        await delay(150);

        const filePath = path.join(tmpDir, "self.md");
        const content = "self-written content";

        echo.markSelfWrite(filePath, content);
        await realFs.writeFile(filePath, content);

        await delay(STABILITY_WAIT);

        expect(events.length).toBe(0);
    });

    it("fires onExternalChange when marked content does not match actual content", async () => {
        const { events, callback } = createCollector();
        const w = startWatcher({ rootDir: tmpDir, onExternalChange: callback });
        stopFn = w.stop;

        await delay(150);

        const filePath = path.join(tmpDir, "mismatch.md");

        echo.markSelfWrite(filePath, "A");
        await realFs.writeFile(filePath, "B");

        await delay(STABILITY_WAIT);

        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].content).toBe("B");
    });

    it("self-write marker is one-shot (second identical write fires)", async () => {
        const { events, callback } = createCollector();
        const w = startWatcher({ rootDir: tmpDir, onExternalChange: callback });
        stopFn = w.stop;

        await delay(150);

        const filePath = path.join(tmpDir, "oneshot.md");
        const content = "shared";

        echo.markSelfWrite(filePath, content);
        await realFs.writeFile(filePath, content);
        await delay(STABILITY_WAIT);

        expect(events.length).toBe(0);

        // Second write of identical content with no fresh marker — fires.
        await realFs.writeFile(filePath, content + "\n"); // touch so chokidar emits
        await delay(STABILITY_WAIT);
        await realFs.writeFile(filePath, content);
        await delay(STABILITY_WAIT);

        expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it("TTL expires the marker so a later identical write fires", async () => {
        const { events, callback } = createCollector();
        const w = startWatcher({ rootDir: tmpDir, onExternalChange: callback });
        stopFn = w.stop;

        await delay(150);

        const filePath = path.join(tmpDir, "ttl.md");
        const content = "ttl-content";

        const realDateNow = Date.now;
        let now = realDateNow();
        const spy = vi.spyOn(Date, "now").mockImplementation(() => now);

        echo.markSelfWrite(filePath, content);

        // Advance "logical" time past TTL (30s).
        now += 31_000;

        await realFs.writeFile(filePath, content);
        await delay(STABILITY_WAIT);

        spy.mockRestore();

        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].content).toBe(content);
    });
});
