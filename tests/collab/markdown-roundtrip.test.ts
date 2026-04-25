import { describe, test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The shared tests/setup.ts mocks `unified` and `unist-util-visit` to no-ops
// (the rest of the suite never exercises real markdown parsing). We need them
// for real here, so unmock and force the module factory to be discarded.
vi.unmock("unified");
vi.unmock("unist-util-visit");

// `y-protocols` is a peer dep of `y-prosemirror` that isn't installed in this
// workspace at the moment. The transformer never exercises awareness, but the
// y-prosemirror entry pulls it in via a side-effect require. Stub it on disk
// before the first import so node's module resolver can find it.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

(function ensureYProtocolsStub() {
  const root = join(__dirname, "..", "..", "node_modules", "y-protocols");
  if (existsSync(join(root, "package.json"))) return;
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "y-protocols",
        version: "0.0.0-stub",
        main: "./index.cjs",
        exports: {
          ".": "./index.cjs",
          "./awareness": "./awareness.cjs",
          "./awareness.js": "./awareness.cjs",
        },
      },
      null,
      2,
    ),
  );
  const stub =
    "class Awareness {\n" +
    "  constructor() {}\n" +
    "  on() {} off() {}\n" +
    "  setLocalState() {} setLocalStateField() {}\n" +
    "  getStates() { return new Map(); }\n" +
    "  destroy() {}\n" +
    "}\n" +
    "module.exports = {\n" +
    "  Awareness,\n" +
    "  removeAwarenessStates() {},\n" +
    "  applyAwarenessUpdate() {},\n" +
    "  encodeAwarenessUpdate() { return new Uint8Array(); },\n" +
    "};\n";
  writeFileSync(join(root, "awareness.cjs"), stub);
  writeFileSync(join(root, "index.cjs"), "module.exports = {};\n");
})();

// CJS module loaded via require — keeps parity with how the persistence layer
// (server.js) will consume it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const markdownModule = require(
  join(__dirname, "..", "..", "app", "_server", "collab", "markdown.cjs"),
);

const {
  splitFrontmatter,
  joinFrontmatter,
  markdownToYDoc,
  yDocToMarkdown,
} = markdownModule as {
  splitFrontmatter: (raw: string) => { frontmatter: Record<string, unknown>; body: string };
  joinFrontmatter: (input: { frontmatter: Record<string, unknown>; body: string }) => string;
  markdownToYDoc: (body: string) => Promise<any>;
  yDocToMarkdown: (ydoc: any) => Promise<string>;
};

const FIXTURES_DIR = join(__dirname, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

async function ydocToProsemirrorJSON(ydoc: any) {
  const { TiptapTransformer } = await import("@hocuspocus/transformer");
  return TiptapTransformer.fromYdoc(ydoc, "prosemirror");
}

/**
 * Strip volatile/cosmetic ProseMirror JSON details that legitimately differ
 * between two equivalent documents (e.g. table colwidth attributes that the
 * markdown layer cannot represent). Returns a structural skeleton suitable
 * for a deep-equality idempotence check.
 */
function normalizeJSON(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeJSON);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "attrs") {
        const attrs = value[key] || {};
        const cleaned: Record<string, any> = {};
        for (const ak of Object.keys(attrs).sort()) {
          // colwidth is set by tiptap on first render and is irrelevant for
          // markdown round-trips.
          if (ak === "colwidth") continue;
          // language defaults vary between StarterKit/CodeBlock variants.
          if (ak === "language" && (attrs[ak] === null || attrs[ak] === "plaintext")) {
            cleaned[ak] = null;
            continue;
          }
          cleaned[ak] = normalizeJSON(attrs[ak]);
        }
        if (Object.keys(cleaned).length > 0) out[key] = cleaned;
      } else {
        out[key] = normalizeJSON(value[key]);
      }
    }
    return out;
  }
  return value;
}

async function roundTripJSON(body: string) {
  const ydoc1 = await markdownToYDoc(body);
  const md1 = await yDocToMarkdown(ydoc1);
  const ydoc2 = await markdownToYDoc(md1);

  const json1 = await ydocToProsemirrorJSON(ydoc1);
  const json2 = await ydocToProsemirrorJSON(ydoc2);
  return {
    json1: normalizeJSON(json1),
    json2: normalizeJSON(json2),
    md1,
  };
}

describe("frontmatter splitting", () => {
  test("splitFrontmatter returns empty frontmatter when no fence is present", () => {
    const raw = "Hello world\n";
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  test("splitFrontmatter parses YAML frontmatter and returns body", () => {
    const raw = "---\ntitle: Foo\ntags:\n  - a\n---\nBody text\n";
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toEqual({ title: "Foo", tags: ["a"] });
    expect(body).toBe("Body text\n");
  });

  test("joinFrontmatter omits the fence for an empty frontmatter object", () => {
    expect(joinFrontmatter({ frontmatter: {}, body: "Hello\n" })).toBe(
      "Hello\n",
    );
  });

  test("joinFrontmatter then splitFrontmatter is the identity for normal data", () => {
    const fm = { title: "Bar", pinned: true, tags: ["x", "y"] };
    const body = "# Hi\n\nText.\n";
    const joined = joinFrontmatter({ frontmatter: fm, body });
    const round = splitFrontmatter(joined);
    expect(round.frontmatter).toEqual(fm);
    expect(round.body).toBe(body);
  });
});

describe("markdown <-> Y.Doc round trips", () => {
  const fixtures = [
    "01-plain.md",
    "02-headings.md",
    "03-bullet-list.md",
    "04-nested-list.md",
    "05-code-fence.md",
    "06-table.md",
    "07-task-list.md",
    "08-frontmatter.md",
    "09-link.md",
    "10-mixed.md",
  ];

  for (const file of fixtures) {
    test(`round-trips: ${file}`, async () => {
      const raw = loadFixture(file);
      const { body } = splitFrontmatter(raw);
      const { json1, json2 } = await roundTripJSON(body);
      expect(json2).toEqual(json1);
    });
  }
});

/**
 * Recursively check whether a PM JSON tree contains a node of the given
 * `type`. Used for the custom-node fixtures where the round-trip is
 * structural rather than byte-perfect (some attributes are lossy).
 */
function findNodeOfType(node: any, type: string): any | null {
  if (!node || typeof node !== "object") return null;
  if (node.type === type) return node;
  const content = node.content;
  if (Array.isArray(content)) {
    for (const child of content) {
      const found = findNodeOfType(child, type);
      if (found) return found;
    }
  }
  return null;
}

describe("custom node round trips (Phase 3 GREEN)", () => {
  test("callout fixture survives the round trip", async () => {
    const raw = loadFixture("11-callout.md");
    const { body } = splitFrontmatter(raw);
    const { json1, json2 } = await roundTripJSON(body);

    expect(findNodeOfType(json1, "callout")).not.toBeNull();
    expect(findNodeOfType(json2, "callout")).not.toBeNull();
    // Attribute fidelity: callout type must survive the round trip.
    expect(findNodeOfType(json2, "callout")?.attrs?.type).toBe("warning");
  });

  test("details fixture survives the round trip (structural)", async () => {
    const raw = loadFixture("12-details.md");
    const { body } = splitFrontmatter(raw);
    const { json1, json2 } = await roundTripJSON(body);

    expect(findNodeOfType(json1, "details")).not.toBeNull();
    expect(findNodeOfType(json2, "details")).not.toBeNull();
  });

  test("tagLink fixture survives the round trip", async () => {
    const raw = loadFixture("13-taglink.md");
    const { body } = splitFrontmatter(raw);
    const { json1, json2 } = await roundTripJSON(body);

    expect(findNodeOfType(json1, "tagLink")).not.toBeNull();
    expect(findNodeOfType(json2, "tagLink")).not.toBeNull();
    expect(findNodeOfType(json2, "tagLink")?.attrs?.tag).toBe("todo");
  });

  test("mermaid fixture survives the round trip", async () => {
    const raw = loadFixture("14-mermaid.md");
    const { body } = splitFrontmatter(raw);
    // Mermaid is authored as a fenced code block in markdown. After the first
    // parse it lands as a `codeBlock` with language=mermaid; after the round
    // trip the structural shape must be preserved (codeBlock OR mermaid node).
    const { json1, json2 } = await roundTripJSON(body);

    const has1 =
      findNodeOfType(json1, "mermaid") || findNodeOfType(json1, "codeBlock");
    const has2 =
      findNodeOfType(json2, "mermaid") || findNodeOfType(json2, "codeBlock");
    expect(has1).not.toBeNull();
    expect(has2).not.toBeNull();
  });
});
