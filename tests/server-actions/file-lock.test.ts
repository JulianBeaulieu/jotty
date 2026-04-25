import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import * as realFs from "fs/promises";

vi.unmock("fs/promises");
vi.unmock("proper-lockfile");

vi.mock("@/app/_server/actions/users", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ username: "testuser" }),
}));

vi.mock("@/app/_server/actions/log", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import { serverWriteFile } from "@/app/_server/actions/file";

describe("serverWriteFile concurrent writes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "jotty-lock-test-"));
  });

  afterEach(async () => {
    await realFs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should not lose or interleave writes under 20 parallel calls", async () => {
    const target = path.join(tmpDir, "shared.md");
    const inputs = Array.from({ length: 20 }, (_, i) => {
      return `payload-${i}-${"x".repeat(1024)}-end-${i}`;
    });

    await Promise.all(inputs.map((content) => serverWriteFile(target, content)));

    const finalContent = await realFs.readFile(target, "utf-8");
    expect(inputs).toContain(finalContent);
  });

  it("should leave no .tmp- residue after concurrent writes", async () => {
    const target = path.join(tmpDir, "residue.md");
    const inputs = Array.from({ length: 10 }, (_, i) => `c-${i}`);

    await Promise.all(inputs.map((content) => serverWriteFile(target, content)));

    const entries = await realFs.readdir(tmpDir);
    const stragglers = entries.filter((n) => n.includes(".tmp-"));
    expect(stragglers).toEqual([]);
  });
});
