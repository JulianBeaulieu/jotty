"use client";

import { useRef } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { useCollabMarkdownText } from "@/app/_hooks/useCollabMarkdownText";

interface MarkdownCollabEditorProps {
    ydoc: Y.Doc | null;
    provider: HocuspocusProvider | null;
    readOnly?: boolean;
    onChange?: (md: string) => void;
    initialValue?: string;
    placeholder?: string;
    className?: string;
}

/**
 * @todo fccview is telling you to review this AI generated code
 * and make sure it's up to standards, reusable, modular and consistent with
 * the rest of the codebase.
 */
export default function MarkdownCollabEditor({
    ydoc,
    provider: _provider,
    readOnly,
    onChange,
    initialValue,
    placeholder,
    className,
}: MarkdownCollabEditorProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Binds the textarea ↔ Y.Text("markdown-source") two-way when ydoc is present.
    useCollabMarkdownText(ydoc, textareaRef, onChange);

    // Fallback: when ydoc is null, behave as a plain controlled-ish textarea using onChange
    // (uncontrolled is acceptable in collab mode; defaultValue keeps initial render stable).
    if (!ydoc) {
        return (
            <textarea
                ref={textareaRef}
                defaultValue={initialValue ?? ""}
                placeholder={placeholder}
                readOnly={readOnly}
                onChange={(e) => onChange?.(e.target.value)}
                className={className}
            />
        );
    }

    return (
        <textarea
            ref={textareaRef}
            // Uncontrolled in collab mode — Y.Text drives ta.value imperatively via the hook.
            defaultValue={initialValue ?? ""}
            placeholder={placeholder}
            readOnly={readOnly}
            className={className}
        />
    );
}
