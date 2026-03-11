import { useEffect, useRef, useCallback, useState } from "react";
import { useLogStore } from "@/stores/log-store";
import { useMissionControlStore } from "@/stores/mission-control-store";

interface EventBusMessage {
  type: string;
  level?: "debug" | "info" | "warn" | "error";
  message?: string;
  source?: string;
  timestamp?: string;
  data?: unknown;
}

interface UseEventBusOptions {
  url?: string;
  maxReconnectAttempts?: number;
}

type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

const INITIAL_BACKOFF = 1000;
const MAX_BACKOFF = 30000;

function calculateBackoff(attempt: number): number {
  const backoff = INITIAL_BACKOFF * Math.pow(2, attempt);
  return Math.min(backoff, MAX_BACKOFF);
}

export function useEventBus(options: UseEventBusOptions = {}) {
  const {
    url = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`,
    maxReconnectAttempts = 10,
  } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");

  const addLogEntry = useLogStore((state) => state.addEntry);
  const setDaemonConnected = useMissionControlStore((state) => state.setDaemonConnected);

  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const rawData = JSON.parse(event.data);
      
      // Handle connection message
      if (rawData.event === 'connected') {
        setDaemonConnected(true);
        return;
      }
      
      // Extract event data - backend sends { event, data } format
      const data: EventBusMessage = {
        type: rawData.event || rawData.type,
        ...rawData.data,
        data: rawData.data,
      };

      // Route events to appropriate stores
      switch (data.type) {
        case "log":
          if (data.level && data.message && data.source) {
            addLogEntry({
              level: data.level,
              message: data.message,
              source: data.source,
            });
          }
          break;

        case "wave":
        case "wave:created":
        case "wave:updated":
        case "wave:progress":
        case "task:progress":
        case "council:vote":
        case "council:consensus":
        case "daemon":
          // These will be handled by specific stores
          window.dispatchEvent(new CustomEvent("daemon:event", { detail: data }));
          break;

        case "daemon:status":
          // Update daemon status
          break;

        default:
          // Dispatch generic event for other handlers
          window.dispatchEvent(new CustomEvent("daemon:event", { detail: data }));
      }
    } catch (err) {
      console.error("[EventBus] Failed to parse message:", err);
    }
  }, [addLogEntry, setDaemonConnected]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      setConnectionStatus("reconnecting");
      wsRef.current = new WebSocket(url);

      wsRef.current.onopen = () => {
        console.log("[EventBus] Connected to daemon");
        setDaemonConnected(true);
        setConnectionStatus("connected");
        reconnectAttemptsRef.current = 0;
      };

      wsRef.current.onmessage = handleMessage;

      wsRef.current.onclose = () => {
        console.log("[EventBus] Disconnected from daemon");
        setDaemonConnected(false);
        setConnectionStatus("disconnected");

        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          const backoff = calculateBackoff(reconnectAttemptsRef.current);
          reconnectAttemptsRef.current++;
          console.log(`[EventBus] Reconnecting in ${backoff}ms (${reconnectAttemptsRef.current}/${maxReconnectAttempts})...`);
          setConnectionStatus("reconnecting");
          
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, backoff);
        } else {
          console.error("[EventBus] Max reconnection attempts reached. Daemon offline.");
        }
      };

      wsRef.current.onerror = (error) => {
        console.error("[EventBus] WebSocket error:", error);
      };
    } catch (err) {
      console.error("[EventBus] Failed to connect:", err);
      setDaemonConnected(false);
      setConnectionStatus("disconnected");
    }
  }, [url, handleMessage, maxReconnectAttempts, setDaemonConnected]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setDaemonConnected(false);
  }, [setDaemonConnected]);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    } else {
      console.warn("[EventBus] Cannot send - not connected");
    }
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    send,
    connect,
    disconnect,
    isConnected: useMissionControlStore((state) => state.daemonConnected),
    connectionStatus,
  };
}