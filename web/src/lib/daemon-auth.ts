let bearerToken = "";
const listeners = new Set<(token: string) => void>();

/** Keep the browser bearer credential in memory only. */
export function setDaemonBearerToken(token: string): void {
  bearerToken = token;
  for (const listener of listeners) listener(token);
}

export function getDaemonBearerToken(): string {
  return bearerToken;
}

export function subscribeDaemonBearerToken(listener: (token: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Exchange the memory-only bearer token for a short-lived, HttpOnly WS cookie. */
export async function establishDaemonBrowserSession(websocketUrl: string): Promise<void> {
  const token = getDaemonBearerToken();
  if (!token) throw new Error("Enter a daemon credential first");
  const ws = new URL(websocketUrl, window.location.href);
  const httpUrl = new URL("/auth/browser-session", `${ws.protocol === "wss:" ? "https:" : "http:"}//${ws.host}`);
  const response = await fetch(httpUrl, {
    method: "POST",
    credentials: "include",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Daemon authentication failed");
}
