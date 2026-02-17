import { useEffect, useRef, useCallback, useState } from "react";

interface SSEStreamOptions {
  url: string;
  onMessage?: (data: unknown) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
  reconnectOnError?: boolean;
  reconnectInterval?: number;
}

interface SSEStreamState {
  isConnected: boolean;
  lastEvent: unknown | null;
  error: string | null;
}

/**
 * SSE hook for streaming responses from the daemon
 * Used for agent response streaming, log streaming, etc.
 */
export function useSSEStream(options: SSEStreamOptions) {
  const {
    url,
    onMessage,
    onError,
    onOpen,
    reconnectOnError = true,
    reconnectInterval = 5000,
  } = options;

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [state, setState] = useState<SSEStreamState>({
    isConnected: false,
    lastEvent: null,
    error: null,
  });

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    try {
      eventSourceRef.current = new EventSource(url);

      eventSourceRef.current.onopen = () => {
        setState((prev) => ({ ...prev, isConnected: true, error: null }));
        onOpen?.();
      };

      eventSourceRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setState((prev) => ({ ...prev, lastEvent: data }));
          onMessage?.(data);
        } catch {
          // Handle non-JSON messages
          setState((prev) => ({ ...prev, lastEvent: event.data }));
          onMessage?.(event.data);
        }
      };

      eventSourceRef.current.onerror = (error) => {
        setState((prev) => ({ ...prev, isConnected: false, error: "Connection error" }));
        onError?.(error);

        if (reconnectOnError) {
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, reconnectInterval);
        }
      };
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isConnected: false,
        error: err instanceof Error ? err.message : "Failed to connect",
      }));
    }
  }, [url, onMessage, onError, onOpen, reconnectOnError, reconnectInterval]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setState((prev) => ({ ...prev, isConnected: false }));
  }, []);

  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  return {
    ...state,
    connect,
    disconnect,
  };
}

/**
 * Hook for streaming agent responses via SSE
 */
export function useAgentStream(sessionId: string | null) {
  const [chunks, setChunks] = useState<string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [fullResponse, setFullResponse] = useState("");

  const { connect, disconnect, isConnected } = useSSEStream({
    url: sessionId ? `/api/stream/${sessionId}` : "",
    onMessage: (data) => {
      if (typeof data === "object" && data !== null) {
        const chunk = data as { type: string; content?: string; done?: boolean };
        
        if (chunk.type === "chunk" && chunk.content) {
          setChunks((prev) => [...prev, chunk.content!]);
          setFullResponse((prev) => prev + chunk.content);
        }
        
        if (chunk.type === "done" || chunk.done) {
          setIsStreaming(false);
        }
      }
    },
    onOpen: () => setIsStreaming(true),
    onError: () => setIsStreaming(false),
    reconnectOnError: false,
  });

  const startStream = useCallback(() => {
    if (!sessionId) return;
    setChunks([]);
    setFullResponse("");
    connect();
  }, [sessionId, connect]);

  const stopStream = useCallback(() => {
    disconnect();
    setIsStreaming(false);
  }, [disconnect]);

  return {
    chunks,
    fullResponse,
    isStreaming,
    isConnected,
    startStream,
    stopStream,
  };
}