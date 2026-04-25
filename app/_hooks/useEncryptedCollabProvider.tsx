"use client";
import { useEffect } from "react";
import * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";

export interface UseEncryptedCollabProviderArgs {
  documentName: string | null;
  enabled: boolean;
  passphrase: string | null;
  encryptionMethod: "pgp" | "xchacha" | null;
}

export interface UseEncryptedCollabProviderResult {
  ydoc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  status: "disabled" | "not-implemented";
  error: string | null;
}

export function useEncryptedCollabProvider(
  args: UseEncryptedCollabProviderArgs,
): UseEncryptedCollabProviderResult {
  useEffect(() => {
    if (args.enabled && args.passphrase) {
      console.warn(
        "[useEncryptedCollabProvider] Encrypted collab is not yet implemented. See docs/COLLAB-ENCRYPTED.md for the design.",
      );
    }
  }, [args.enabled, args.passphrase]);
  return {
    ydoc: null,
    provider: null,
    status: args.enabled ? "not-implemented" : "disabled",
    error: null,
  };
}
