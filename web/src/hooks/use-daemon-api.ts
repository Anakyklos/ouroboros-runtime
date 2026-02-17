import { useEffect, useRef, useCallback, useState } from "react";
import { useMissionControlStore } from "@/stores/mission-control-store";

interface DaemonAPIOptions {
  baseUrl?: string;
}

interface DaemonStatus {
  status: "running" | "paused" | "error";
  uptime: number;
  activeWaves: number;
  activeTasks: number;
  tokensUsed: number;
}

export function useDaemonAPI(options: DaemonAPIOptions = {}) {
  const { baseUrl = "/api" } = options;
  
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const setDaemonConnected = useMissionControlStore((state) => state.setDaemonConnected);

  const rpcCall = useCallback(async <T,>(method: string, params?: unknown): Promise<T> => {
    const response = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`RPC call failed: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error.message || "RPC error");
    }

    return data.result;
  }, [baseUrl]);

  const fetchStatus = useCallback(async () => {
    try {
      const result = await rpcCall<DaemonStatus>("daemon.status");
      setStatus(result);
      setDaemonConnected(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setDaemonConnected(false);
    }
  }, [rpcCall, setDaemonConnected]);

  const startPolling = useCallback((interval = 5000) => {
    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, interval);
  }, [fetchStatus]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const setMode = useCallback(async (mode: "pause" | "running" | "frenzy") => {
    setIsLoading(true);
    try {
      await rpcCall("daemon.setMode", { mode });
      await fetchStatus();
    } finally {
      setIsLoading(false);
    }
  }, [rpcCall, fetchStatus]);

  const emergencyBrake = useCallback(async () => {
    setIsLoading(true);
    try {
      await rpcCall("daemon.emergencyBrake");
      await fetchStatus();
    } finally {
      setIsLoading(false);
    }
  }, [rpcCall, fetchStatus]);

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  return {
    status,
    isLoading,
    error,
    rpcCall,
    setMode,
    emergencyBrake,
    refresh: fetchStatus,
  };
}