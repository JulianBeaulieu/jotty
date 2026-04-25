export const COLLAB_ENABLED =
  typeof process !== "undefined" &&
  process.env?.NEXT_PUBLIC_COLLAB_ENABLED === "true";

export const COLLAB_WS_PATH = "/_ws/collab/";

export function buildCollabUrl(): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${COLLAB_WS_PATH}`;
}

export function userColorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 70% 55%)`;
}
