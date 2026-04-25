"use client";

import { useEffect, useState } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";

interface PresenceUser {
  clientId: number;
  name: string;
  color: string;
}

interface Props {
  provider: HocuspocusProvider | null;
}

export function CollabPresenceBadge({ provider }: Props) {
  const [users, setUsers] = useState<PresenceUser[]>([]);

  useEffect(() => {
    if (!provider) return;
    const awareness = provider.awareness;
    if (!awareness) return;

    const update = () => {
      const next: PresenceUser[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (state?.user?.name) {
          next.push({
            clientId,
            name: state.user.name,
            color: state.user.color || "#888",
          });
        }
      });
      setUsers(next);
    };

    update();
    awareness.on("change", update);
    return () => {
      awareness.off("change", update);
    };
  }, [provider]);

  if (!provider || users.length === 0) return null;

  return (
    <div
      className="flex items-center gap-1 text-xs opacity-70"
      title="People editing this note"
    >
      {users.slice(0, 5).map((u) => (
        <span
          key={u.clientId}
          className="inline-flex w-5 h-5 rounded-full text-white text-[10px] font-semibold items-center justify-center"
          style={{ background: u.color }}
          title={u.name}
        >
          {u.name.charAt(0).toUpperCase()}
        </span>
      ))}
      {users.length > 5 && <span>+{users.length - 5}</span>}
    </div>
  );
}
