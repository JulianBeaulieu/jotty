# Collaborative Editing for Encrypted Notes

Status: Design proposal. Not implemented. The current `persistence.cjs`
`_isEncryptedFrontmatter` gate intentionally refuses to seed/persist Y.Docs
for encrypted notes, because the server lacks the passphrase. This document
describes how to lift that restriction safely.

## 1. Threat Model

- **Server (jotty.page / self-hosted node):** Untrusted with respect to note
  contents. May persist ciphertext, route Yjs updates, and observe metadata
  (document name, connection times, update sizes), but MUST NOT see plaintext.
- **Clients (browsers):** Trusted. Hold the passphrase in memory for the
  duration of a session. Passphrase NEVER leaves the client over the network
  in any form (raw, hashed, wrapped) unless wrapped to a peer's public key.
- **Network:** Assumed to be TLS-protected end-to-end, but the server
  terminates TLS, so the server boundary is the real trust boundary.
- **Out-of-band channel:** Required for sharing per-note passphrases between
  collaborators. Out of scope for this document.

## 2. Design Options

### Option A — E2EE with Shared Symmetric Key

- First client opens the note, decrypts ciphertext locally with passphrase,
  seeds a Y.Doc from the plaintext.
- Y.Doc state contains plaintext.
- Before sending Yjs updates over the WebSocket, the client encrypts each
  update with a session symmetric key derived from the passphrase (e.g.,
  HKDF over the passphrase + per-note salt → XChaCha20-Poly1305 key).
- The server stores opaque encrypted Yjs state and forwards it to other
  clients, who decrypt locally.
- On flush, the merged plaintext is re-encrypted via the existing
  `encryptNoteContent` / `encryptXChaCha` paths and persisted as ciphertext
  through the normal write flow.
- Pros: True multi-user encrypted collab. Server sees nothing.
- Cons: Substantial new crypto surface. Requires Hocuspocus extension or a
  custom transport wrapper. Passphrase must be shared out-of-band with every
  collaborator. No revocation story.

### Option B — Hybrid (Sealed-Mode for Encrypted Notes)

- Non-encrypted notes use the existing collab path unchanged.
- Encrypted notes open in **sealed mode**: single active editor, no Y.Doc
  on the server, no real-time presence. The second connection sees a clear
  warning ("This note is encrypted; collaborative editing is disabled. Open
  read-only or wait for the active editor to close.") and is denied a
  Y.Doc-backed session.
- Pros: Zero new crypto. Ships in days, not weeks. Preserves the current
  server-blind invariant. Honest UX.
- Cons: No real-time collab on encrypted notes.

### Option C — Passphrase-Wrapped Session Key (PGP-Native)

- For PGP-encrypted notes, generate a per-session symmetric key on the
  initiating client. Wrap it with each authorized recipient's PGP public
  key (already known to the system) and attach the wrapped keys to the
  document handshake.
- Recipients unwrap using their private PGP key (already used to decrypt
  the note), recover the session key, and proceed as in Option A.
- Pros: No out-of-band passphrase sharing — leverages PGP recipient list
  the user already manages. Per-session keys give natural revocation.
- Cons: Only applies to PGP notes (not XChaCha-passphrase notes). Requires
  recipients to have unlocked their private key in-session. More moving
  parts than A.

## 3. Recommendation

**Start with Option B.** It is the only path that ships under the current
"server is untrusted" invariant without inventing new crypto, and it
matches user expectations: encryption is the strong promise, collab is the
weaker one. Sealed-mode with a clear warning is better than a half-built
E2EE Yjs transport that quietly leaks plaintext via a misconfigured relay.

**Plan Option C as the long-term path** for PGP notes — it removes the
out-of-band passphrase sharing problem that Option A inherits, and PGP
already gives jotty the recipient identity model required to make
session-key wrapping practical. Option A (passphrase-derived shared key)
remains a fallback for XChaCha-passphrase notes if multi-user collab is
demanded there.

## 4. Plumbing Required (Any Option)

1. **Decrypt-at-session-open helper:** Client-side wrapper that calls the
   existing `decryptNote*` server actions with the in-memory passphrase
   and returns plaintext + metadata.
2. **Y.Doc seeding from plaintext:** Mirror the seeding path used for
   unencrypted notes, but driven by the client, not by `persistence.cjs`.
3. **Flush / re-encrypt:** On debounce or unload, take the current Y.Doc
   text, encrypt via `encryptNoteContent` / `encryptXChaCha`, and write
   ciphertext through the normal persistence path. The server's
   `_isEncryptedFrontmatter` gate must be bypassed for these writes via a
   new context flag, e.g. `document.context.encryptedSessionKey === true`,
   so the server knows "this write is from a session that has already
   re-encrypted client-side; treat the body as opaque ciphertext."
4. **Per-update encryption (Option A/C only):** A Hocuspocus extension or
   client middleware that wraps every outgoing Yjs update with the session
   key and unwraps every incoming one. The server only ever sees
   ciphertext blobs.
5. **Sealed-mode lock (Option B):** Server tracks at most one active
   provider per encrypted document and rejects subsequent connections with
   a typed close reason the client can render as a friendly warning.

## 5. Open Questions

- **Passphrase entry timing:** At session open? Cached client-side across
  notes for the session? Cleared on tab close vs. on idle timeout?
- **Second-user-without-passphrase behavior:** Sealed-mode warning + reject
  is the working answer for B. For A/C, what's the UX when wrapping fails?
- **Mid-session passphrase compromise:** No revocation in Option A — a
  leaked passphrase compromises every past and future update. Option C's
  per-session keys give partial forward secrecy but require re-wrapping on
  recipient changes.
- **Metadata leakage:** Document names, update sizes, edit cadence, and
  presence are all visible to the server even under Option A. Acceptable?
- **Persistence format:** Does the server store encrypted Yjs CRDT state
  (and reconstruct via replay), or only the latest ciphertext body? The
  former gives offline merge; the latter is simpler.

## 6. Stub

`app/_hooks/useEncryptedCollabProvider.tsx` is a typed stub mirroring the
shape of `useCollabProvider`. It logs a clear "not yet implemented" warning
when invoked with `enabled: true` and returns `{ ydoc: null, provider: null,
status: "disabled" | "not-implemented", error: null }`. The args interface
exposes `passphrase` and `encryptionMethod` as the extension points future
implementations of any of A/B/C will need.
