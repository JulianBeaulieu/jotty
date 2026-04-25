"use strict";

/**
 * Markdown <-> Y.Doc transformer for jotty's real-time collaboration layer.
 *
 * The on-disk format for notes is Markdown (with optional YAML frontmatter).
 * The collab runtime works on Y.Doc instances. This module is the bridge:
 *   - markdownToYDoc: parse markdown body -> HTML -> ProseMirror JSON -> Y.Doc
 *   - yDocToMarkdown: Y.Doc -> ProseMirror JSON -> HTML -> markdown
 *   - splitFrontmatter / joinFrontmatter: keep YAML metadata round-tripping
 *
 * The MVP extension set is intentionally narrow: StarterKit (no history),
 * TaskList/TaskItem, Table*, CodeBlock, Link. Custom extensions (Mermaid,
 * Drawio, Excalidraw, Callout, TagLink, InternalLink) are out of scope here
 * because they are React-coupled and would force the persistence layer to
 * pull in the full client editor stack.
 */

const yaml = require("js-yaml");
const TurndownService = require("turndown");
const turndownPluginGfm = require("turndown-plugin-gfm");
const domino = require("@mixmark-io/domino");

// domino does not ship a DOMParser class; tiptap's `generateJSON` calls
// `new window.DOMParser().parseFromString(html, "text/html")` so we shim one
// that returns a domino-backed Document.
class DominoDOMParser {
  parseFromString(html, _mimeType) {
    return domino.createDocument(html, true);
  }
}

// Domino's DOMTokenList lacks Symbol.iterator, but tiptap (e.g. extension-
// code-block) does `[...element.firstElementChild?.classList]`. Patch the
// prototype once so that spread / for-of works.
function patchDOMTokenListIterator() {
  try {
    const DOMTokenList = require("@mixmark-io/domino/lib/DOMTokenList");
    if (DOMTokenList && DOMTokenList.prototype && !DOMTokenList.prototype[Symbol.iterator]) {
      Object.defineProperty(DOMTokenList.prototype, Symbol.iterator, {
        value: function* () {
          const len = this.length || 0;
          for (let i = 0; i < len; i++) yield this.item(i);
        },
        writable: true,
        configurable: true,
      });
    }
  } catch (_err) {
    // Best-effort; if domino's internal layout changes, fail silently and
    // let the caller's surrounding error handling surface a useful trace.
  }
}

let domInstalled = false;
function ensureDom() {
  if (domInstalled) return;
  if (typeof globalThis.window === "undefined") {
    const win = domino.createWindow("<!doctype html><html><body></body></html>");
    win.DOMParser = DominoDOMParser;
    globalThis.window = win;
  } else if (!globalThis.window.DOMParser) {
    globalThis.window.DOMParser = DominoDOMParser;
  }
  if (typeof globalThis.document === "undefined") {
    globalThis.document = globalThis.window.document;
  }
  if (typeof globalThis.DOMParser === "undefined") {
    globalThis.DOMParser = DominoDOMParser;
  }
  patchDOMTokenListIterator();
  domInstalled = true;
}

let cachedExtensions = null;
async function getExtensions() {
  if (cachedExtensions) return cachedExtensions;
  const { default: StarterKit } = await import("@tiptap/starter-kit");
  const { default: Link } = await import("@tiptap/extension-link");
  const { TaskList } = await import("@tiptap/extension-task-list");
  const { TaskItem } = await import("@tiptap/extension-task-item");
  const { Table } = await import("@tiptap/extension-table");
  const { TableRow } = await import("@tiptap/extension-table-row");
  const { TableHeader } = await import("@tiptap/extension-table-header");
  const { TableCell } = await import("@tiptap/extension-table-cell");
  const { CodeBlock } = await import("@tiptap/extension-code-block");

  const baseExtensions = [
    StarterKit.configure({
      history: false,
      codeBlock: false,
      link: false,
    }),
    CodeBlock,
    Link.configure({ openOnClick: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
  ];

  // Phase 3 GREEN-tier: include schema-only mirrors of Callout / Details /
  // TagLink so that custom nodes survive the markdown <-> Y.Doc round trip.
  // Loaded best-effort: any failure here falls back to the base set.
  let customExtensions = [];
  try {
    const { buildCustomNodeExtensions } = require("./customNodes.cjs");
    customExtensions = await buildCustomNodeExtensions();
  } catch (_err) {
    customExtensions = [];
  }

  cachedExtensions = [...baseExtensions, ...customExtensions];
  return cachedExtensions;
}

let mdProcessor = null;
async function getMarkdownProcessor() {
  if (mdProcessor) return mdProcessor;
  const { unified } = await import("unified");
  const remarkParse = (await import("remark-parse")).default;
  const remarkGfm = (await import("remark-gfm")).default;
  const remarkRehype = (await import("remark-rehype")).default;
  const rehypeRaw = (await import("rehype-raw")).default;
  const rehypeStringify = (await import("rehype-stringify")).default;

  mdProcessor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeStringify, { allowDangerousHtml: true });
  return mdProcessor;
}

function makeTurndown() {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  service.use(turndownPluginGfm.gfm);

  // Preserve fenced code language.
  service.addRule("fencedCodeBlockWithLang", {
    filter: function (node) {
      return (
        node.nodeName === "PRE" &&
        node.firstChild &&
        node.firstChild.nodeName === "CODE"
      );
    },
    replacement: function (_content, node) {
      const code = node.firstChild;
      const className = (code.getAttribute && code.getAttribute("class")) || "";
      const langMatch = className.match(/language-(\S+)/);
      const language = langMatch ? langMatch[1] : "";
      const text = code.textContent || "";
      const trimmed = text.replace(/\n$/, "");
      return "\n\n```" + language + "\n" + trimmed + "\n```\n\n";
    },
  });

  // Custom node: callout. Emit raw HTML — markdown allows it and rehype-raw
  // re-parses it on the way back in, so we keep `data-callout-type` intact.
  service.addRule("jottyCallout", {
    filter: function (node) {
      return (
        node.nodeName === "DIV" &&
        node.getAttribute &&
        node.getAttribute("data-type") === "callout"
      );
    },
    replacement: function (content, node) {
      const type = node.getAttribute("data-callout-type") || "info";
      const inner = (content || "").replace(/^\n+|\n+$/g, "");
      return (
        '\n\n<div data-type="callout" data-callout-type="' +
        type +
        '"><div class="callout-content">\n\n' +
        inner +
        "\n\n</div></div>\n\n"
      );
    },
  });

  // Custom node: details/summary. Markdown round-trips this via raw HTML.
  service.addRule("jottyDetails", {
    filter: function (node) {
      return node.nodeName === "DETAILS";
    },
    replacement: function (_content, node) {
      const summaryEl = node.querySelector && node.querySelector("summary");
      const summary = (summaryEl && summaryEl.textContent) || "Details";
      // Render inner content (excluding the summary) by serialising children.
      let innerMd = "";
      if (node.childNodes) {
        const TurndownCtor = TurndownService;
        const tmp = new TurndownCtor({
          headingStyle: "atx",
          codeBlockStyle: "fenced",
          fence: "```",
          bulletListMarker: "-",
          emDelimiter: "_",
        });
        tmp.use(turndownPluginGfm.gfm);
        // Walk children, skip the summary element.
        const parts = [];
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeName === "SUMMARY") continue;
          if (child.outerHTML) {
            parts.push(tmp.turndown(child.outerHTML));
          } else if (child.textContent) {
            parts.push(child.textContent);
          }
        }
        innerMd = parts.join("\n\n").replace(/^\n+|\n+$/g, "");
      }
      return (
        "\n\n<details><summary>" +
        summary +
        "</summary>\n\n" +
        innerMd +
        "\n\n</details>\n\n"
      );
    },
  });

  // Custom node: tagLink. Preserve the data attribute so round-tripping
  // produces the same PM node (a bare `#tag` would parse back as text).
  service.addRule("jottyTagLink", {
    filter: function (node) {
      return (
        node.nodeName === "SPAN" &&
        node.getAttribute &&
        node.getAttribute("data-tag")
      );
    },
    replacement: function (_content, node) {
      const tag = node.getAttribute("data-tag");
      return '<span data-tag="' + tag + '">' + tag + "</span>";
    },
  });

  // Custom node: mermaid. Emit a fenced code block — that's how mermaid
  // diagrams are typically authored in markdown anyway.
  service.addRule("jottyMermaid", {
    filter: function (node) {
      return (
        node.nodeName === "DIV" &&
        node.getAttribute &&
        node.hasAttribute("data-mermaid")
      );
    },
    replacement: function (_content, node) {
      const code = node.getAttribute("data-mermaid-content") || "";
      const trimmed = code.replace(/\n$/, "");
      return "\n\n```mermaid\n" + trimmed + "\n```\n\n";
    },
  });

  // Task list items: turndown-plugin-gfm handles them, but we normalise the
  // tiptap `data-type="taskItem"` markup just in case.
  service.addRule("tiptapTaskItem", {
    filter: function (node) {
      return (
        node.nodeName === "LI" &&
        node.getAttribute &&
        node.getAttribute("data-type") === "taskItem"
      );
    },
    replacement: function (content, node) {
      const checked = node.getAttribute("data-checked") === "true";
      const marker = checked ? "[x]" : "[ ]";
      const inner = content.replace(/^\n+|\n+$/g, "").replace(/\n/g, "\n  ");
      return "- " + marker + " " + inner + "\n";
    },
  });

  return service;
}

function splitFrontmatter(rawMarkdown) {
  if (typeof rawMarkdown !== "string") {
    return { frontmatter: {}, body: "" };
  }
  const match = rawMarkdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: rawMarkdown };
  }
  let frontmatter = {};
  try {
    const parsed = yaml.load(match[1]);
    frontmatter =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
  } catch (_err) {
    frontmatter = {};
  }
  return { frontmatter, body: match[2] || "" };
}

function joinFrontmatter({ frontmatter, body }) {
  const fm = frontmatter || {};
  const safeBody = body == null ? "" : String(body);
  if (!fm || typeof fm !== "object" || Object.keys(fm).length === 0) {
    return safeBody;
  }
  const dumped = yaml.dump(fm);
  return "---\n" + dumped + "---\n" + safeBody;
}

async function markdownToHtml(body) {
  const processor = await getMarkdownProcessor();
  const file = await processor.process(body || "");
  return String(file);
}

async function htmlToProsemirrorJSON(html) {
  ensureDom();
  const { generateJSON } = await import("@tiptap/core");
  const extensions = await getExtensions();
  return generateJSON(html, extensions);
}

async function prosemirrorJSONToHtml(json) {
  ensureDom();
  const { generateHTML } = await import("@tiptap/core");
  const extensions = await getExtensions();
  return generateHTML(json, extensions);
}

async function markdownToYDoc(markdownBody) {
  const html = await markdownToHtml(markdownBody);
  const json = await htmlToProsemirrorJSON(html);
  const { TiptapTransformer } = await import("@hocuspocus/transformer");
  const extensions = await getExtensions();
  return TiptapTransformer.toYdoc(json, "prosemirror", extensions);
}

async function yDocToMarkdown(ydoc) {
  const { TiptapTransformer } = await import("@hocuspocus/transformer");
  const json = TiptapTransformer.fromYdoc(ydoc, "prosemirror");
  const html = await prosemirrorJSONToHtml(json);
  const turndown = makeTurndown();
  const md = turndown.turndown(html);
  return md.replace(/\s+$/g, "") + "\n";
}

module.exports = {
  splitFrontmatter,
  joinFrontmatter,
  markdownToYDoc,
  yDocToMarkdown,
  // Exposed for tests / advanced callers.
  _internal: {
    markdownToHtml,
    htmlToProsemirrorJSON,
    prosemirrorJSONToHtml,
    getExtensions,
  },
};
