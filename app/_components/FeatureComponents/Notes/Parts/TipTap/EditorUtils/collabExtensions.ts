import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { userColorFromName } from "@/app/_consts/collab";

export interface CollabExtensionArgs {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  username: string;
}

export function buildCollabExtensions({
  ydoc,
  provider,
  username,
}: CollabExtensionArgs) {
  return [
    Collaboration.configure({
      document: ydoc,
      field: "prosemirror",
    }),
    CollaborationCursor.configure({
      provider,
      user: { name: username, color: userColorFromName(username) },
    }),
  ];
}
