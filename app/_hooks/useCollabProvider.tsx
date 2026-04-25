"use client";

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { buildCollabUrl, COLLAB_ENABLED } from "@/app/_consts/collab";

export type CollabStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "disconnected";

export interface UseCollabProviderArgs {
  documentName: string | null;
  enabled: boolean;
}

export interface UseCollabProviderResult {
  ydoc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  status: CollabStatus;
}

export function useCollabProvider({
  documentName,
  enabled,
}: UseCollabProviderArgs): UseCollabProviderResult {
  const [status, setStatus] = useState<CollabStatus>("disabled");
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const idbRef = useRef<IndexeddbPersistence | null>(null);

  useEffect(() => {
    if (!enabled || !COLLAB_ENABLED || !documentName) {
      setStatus("disabled");
      return;
    }
    setStatus("connecting");
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    const idb = new IndexeddbPersistence(documentName, ydoc);
    idbRef.current = idb;
    const provider = new HocuspocusProvider({
      url: buildCollabUrl(),
      name: documentName,
      document: ydoc,
      onStatus({ status: nextStatus }) {
        if (nextStatus === "connected") setStatus("connected");
        else if (nextStatus === "disconnected") setStatus("disconnected");
        else setStatus("connecting");
      },
    });
    providerRef.current = provider;

    return () => {
      provider.destroy();
      idb.destroy();
      ydoc.destroy();
      providerRef.current = null;
      idbRef.current = null;
      ydocRef.current = null;
      setStatus("disabled");
    };
  }, [documentName, enabled]);

  return {
    ydoc: ydocRef.current,
    provider: providerRef.current,
    status,
  };
}
