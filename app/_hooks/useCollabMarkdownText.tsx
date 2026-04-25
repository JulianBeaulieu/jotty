"use client";

// Markdown-mode collab path: binds a textarea to a Y.Text named "markdown-source".
// Tradeoff: full-replace diff loses fine-grained collaborative editing — concurrent edits in
// different regions still merge via Y.Text's CRDT, but the UI experience won't show character-level
// operations. For markdown notes (typically smaller and less concurrent than rich notes), this
// tradeoff is acceptable. Future: switch to a proper diff-based delta (e.g., y-textarea or fast-diff).
//
// SERVER-SIDE CHANGE NEEDED (future PR, not this scaffold):
// The Hocuspocus server must know which Y representation a doc uses (Y.XmlFragment for rich vs
// Y.Text "markdown-source" for markdown) so it can choose the right seeding strategy on first
// connect. MVP plan: client passes a hint via the WS URL query string, e.g.
// `/_ws/collab/<docName>?mode=markdown`. The server's onLoadDocument handler should consult this
// param and seed the Y.Doc accordingly (read .md file → ytext.insert(0, content) for markdown mode).

import { useEffect, useRef } from "react";
import * as Y from "yjs";

/**
 * @todo fccview is telling you to review this AI generated code
 * and make sure it's up to standards, reusable, modular and consistent with
 * the rest of the codebase.
 */
export function useCollabMarkdownText(
    ydoc: Y.Doc | null,
    textareaRef: React.RefObject<HTMLTextAreaElement | null>,
    onChange?: (md: string) => void
) {
    const isApplyingRemote = useRef(false);
    const onChangeRef = useRef(onChange);

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
        const ta = textareaRef.current;
        if (!ydoc || !ta) return;

        const ytext = ydoc.getText("markdown-source");

        // Initial seed from Y.Text into textarea (Y.Text wins on first paint when populated).
        const initial = ytext.toString();
        if (ta.value !== initial) {
            ta.value = initial;
        }

        const onYjsChange = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
            // Skip echo of our own local-input transaction; we already mirror the textarea value.
            if (transaction.origin === "local-input") return;
            const next = ytext.toString();
            if (ta.value !== next) {
                const sel = { start: ta.selectionStart, end: ta.selectionEnd };
                isApplyingRemote.current = true;
                ta.value = next;
                try {
                    ta.setSelectionRange(sel.start, sel.end);
                } catch {
                    // setSelectionRange can throw on out-of-range or detached inputs; ignore.
                }
                isApplyingRemote.current = false;
                onChangeRef.current?.(ta.value);
            }
        };
        ytext.observe(onYjsChange);

        const onInput = () => {
            if (isApplyingRemote.current) return;
            const value = ta.value;
            // MVP: full replace within a single transaction. CRDT merges still happen at the doc level,
            // but operations are coarse-grained. See top-of-file tradeoff note.
            ydoc.transact(() => {
                ytext.delete(0, ytext.length);
                ytext.insert(0, value);
            }, "local-input");
            onChangeRef.current?.(value);
        };
        ta.addEventListener("input", onInput);

        return () => {
            ytext.unobserve(onYjsChange);
            ta.removeEventListener("input", onInput);
        };
    }, [ydoc, textareaRef]);
}
