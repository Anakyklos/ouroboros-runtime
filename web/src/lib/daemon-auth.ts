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

/** Normalize configured daemon addresses to the one supported stream route. */
export function normalizeDaemonWebSocketUrl(websocketUrl: string, baseUrl?: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(websocketUrl, baseUrl ?? window.location.href);
  } catch {
    throw new Error("Daemon WebSocket URL is invalid");
  }
  if ((endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || (endpoint.pathname !== "/" && endpoint.pathname !== "/ws")) {
    throw new Error("Daemon WebSocket URL is invalid");
  }
  endpoint.pathname = "/ws";
  return endpoint.toString();
}

/** Exchange the memory-only bearer token for a short-lived, HttpOnly WS cookie. */
export async function establishDaemonBrowserSession(websocketUrl: string): Promise<void> {
  const token = getDaemonBearerToken();
  if (!token) throw new Error("Enter a daemon credential first");
  const ws = new URL(normalizeDaemonWebSocketUrl(websocketUrl));
  const httpUrl = new URL("/auth/browser-session", `${ws.protocol === "wss:" ? "https:" : "http:"}//${ws.host}`);
  const response = await fetch(httpUrl, {
    method: "POST",
    credentials: "include",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status !== 204) throw new Error("Daemon authentication failed");
}

/** Confirm a real snapshot arrived from the configured daemon WebSocket. */
export function waitForDaemonSnapshot(websocketUrl: string, timeoutMs = 5_000): Promise<void> {
  const socket = new WebSocket(normalizeDaemonWebSocketUrl(websocketUrl));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Daemon snapshot timed out")), timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    socket.onmessage = (event) => {
      try {
        const envelope = JSON.parse(String(event.data)) as { event?: unknown; data?: { protocolVersion?: unknown } };
        if (envelope.event === "snapshot" && envelope.data?.protocolVersion === 1) finish();
      } catch {
        finish(new Error("Daemon sent an invalid snapshot"));
      }
    };
    socket.onerror = () => finish(new Error("Daemon WebSocket connection failed"));
    socket.onclose = () => {
      if (!settled) finish(new Error("Daemon WebSocket closed before its snapshot"));
    };
  });
}
