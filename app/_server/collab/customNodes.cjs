"use strict";

/**
 * Server-side schema-only mirrors of the React-coupled custom TipTap nodes
 * defined under app/_components/.../TipTap/CustomExtensions. These omit
 * NodeViews, commands, keyboard shortcuts and input rules - the markdown
 * <-> Y.Doc transformer only needs name, group, content, attributes,
 * parseHTML and renderHTML so that nodes survive the round trip.
 *
 * Source files (do not modify): CalloutExtension.tsx, DetailsExtension.tsx,
 * TagLink.tsx.
 */

async function buildCustomNodeExtensions() {
  const { Node, mergeAttributes } = await import("@tiptap/core");

  const Callout = Node.create({
    name: "callout",
    group: "block",
    content: "block+",
    defining: true,

    addAttributes() {
      return {
        type: {
          default: "info",
          parseHTML: (element) =>
            element.getAttribute("data-callout-type") || "info",
          renderHTML: (attributes) => ({
            "data-callout-type": attributes.type,
          }),
        },
      };
    },

    parseHTML() {
      return [
        {
          tag: 'div[data-type="callout"]',
          getAttrs: (dom) => {
            return {
              type: dom.getAttribute("data-callout-type") || "info",
            };
          },
          contentElement: (dom) => {
            return dom.querySelector(".callout-content") || dom;
          },
        },
      ];
    },

    renderHTML({ node, HTMLAttributes }) {
      const type = node.attrs.type || "info";
      return [
        "div",
        mergeAttributes(HTMLAttributes, {
          "data-type": "callout",
          "data-callout-type": type,
          class: `callout callout-${type}`,
        }),
        [
          "div",
          { class: "callout-wrapper" },
          ["span", { class: `callout-icon callout-icon-${type}` }],
          ["div", { class: "callout-content" }, 0],
        ],
      ];
    },
  });

  const Details = Node.create({
    name: "details",
    group: "block",
    content: "block+",
    defining: true,

    addAttributes() {
      return {
        summary: {
          default: "Details",
        },
      };
    },

    parseHTML() {
      return [
        {
          tag: "details",
          getAttrs: (dom) => {
            const summaryElement = dom.querySelector("summary");
            return {
              summary: summaryElement?.textContent || "Details",
            };
          },
          contentElement: (dom) => {
            const summaryElement = dom.querySelector("summary");
            if (summaryElement) {
              summaryElement.remove();
            }
            const contentWrapper = dom.querySelector("div");
            return contentWrapper || dom;
          },
        },
      ];
    },

    renderHTML({ node, HTMLAttributes }) {
      return [
        "details",
        mergeAttributes(HTMLAttributes),
        ["summary", node.attrs.summary || "Details"],
        ["div", 0],
      ];
    },
  });

  const TagLink = Node.create({
    name: "tagLink",
    group: "inline",
    inline: true,
    atom: true,

    addAttributes() {
      return {
        tag: {
          default: null,
        },
      };
    },

    parseHTML() {
      return [
        {
          tag: "span[data-tag]",
          getAttrs: (element) => {
            if (typeof element === "string") return false;
            const tag = element.getAttribute("data-tag");
            return tag ? { tag } : false;
          },
        },
      ];
    },

    renderHTML({ node }) {
      const { tag } = node.attrs;
      return [
        "span",
        {
          "data-tag": tag,
        },
        tag,
      ];
    },
  });

  return [Callout, Details, TagLink];
}

module.exports = { buildCustomNodeExtensions };
