"use client";

import { COLLAB_ENABLED } from "@/app/_consts/collab";

interface Props {
  isEncrypted: boolean;
}

/**
 * @todo fccview is telling you to review this AI generated code
 * and make sure it's up to standards, reusable, modular and consistent with
 * the rest of the codebase.
 */
export function EncryptedCollabNotice({ isEncrypted }: Props) {
  if (!COLLAB_ENABLED || !isEncrypted) return null;
  return (
    <div className="mb-2 px-3 py-2 rounded-md text-xs border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
      <strong>Encrypted note:</strong> real-time collaboration is unavailable
      because the server cannot decrypt this note. You&apos;re editing solo. To
      collaborate, decrypt the note (sealed-mode workaround coming in a future
      release).
    </div>
  );
}
