import { useEffect, useRef, useCallback, useState } from "react";
import {
  useMissionControlStore,
  type DaemonCapabilities,
  type DaemonMode,
  DEFAULT_CAPABILITIES,
} from "@/stores/mission-control-store";

interface DaemonAPIOptions {
  baseUrl?: string;
}

interface MetricValue {
  available: boolean;
  value?: number;
  unit?: string;
  reason?: string;
}

/** Backend daemon.status payload (issue #37). */
export interface DaemonStatus {
  processStatus: "alive";
  mode: DaemonMode;
  uptimeSeconds: number;
  activeSessions: MetricValue;
  activeWaves: MetricValue;
  activeTasks: MetricValue;
  tokensUsed: MetricValue;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
  capabilities: DaemonCapabilities;
  timestamp: string;
}

export interface SetModeResult {
  operation: "applied" | "unchanged" | "rejected_invalid_mode" | "rejected_invalid_transition";
  previousMode: DaemonMode;
  requestedMode: string | null;
  resultingMode: DaemonMode;
  reason?: string;
  timestamp: string;
}

export interface EmergencyBrakeResult {
  outcome: "no_active_work" | "all_stopped" | "partial" | "already_stopped";
  complete: boolean;
  interruptedCount: number;
  failedCount: number;
  mode: DaemonMode;
  message: string;
  timestamp: string;
  sessions: Array<{ sessionId: string; status: string; error?: string }>;
}

function metricNumber(m: MetricValue | undefined): number | undefined {
  if (m?.available && typeof m.value === "number") return m.value;
  return undefined;
}

export function useDaemonAPI(options: DaemonAPIOptions = {}) {
  const { baseUrl = "/api" } = options;

  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const setDaemonConnected = useMissionControlStore((s) => s.setDaemonConnected);
  const setCapabilities = useMissionControlStore((s) => s.setCapabilities);
  const applyDaemonMetrics = useMissionControlStore((s) => s.applyDaemonMetrics);
  const setLastControlError = useMissionControlStore((s) => s.setLastControlError);
  const setLastBrakeOutcome = useMissionControlStore((s) => s.setLastBrakeOutcome);
  const applyEmergencyBrakeLocally = useMissionControlStore((s) => s.applyEmergencyBrakeLocally);
  const storeSetMode = useMissionControlStore((s) => s.setMode);
  const capabilities = useMissionControlStore((s) => s.capabilities);

  const rpcCall = useCallback(
    async <T,>(method: string, params?: unknown): Promise<T> => {
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

      return data.result as T;
    },
    [baseUrl]
  );

  const fetchStatus = useCallback(async () => {
    try {
      const result = await rpcCall<DaemonStatus>("daemon.status");
      setStatus(result);
      setDaemonConnected(true);
      setCapabilities(result.capabilities ?? { ...DEFAULT_CAPABILITIES });
      applyDaemonMetrics({
        mode: result.mode,
        activeTasks: metricNumber(result.activeTasks),
        activeWaves: metricNumber(result.activeWaves),
        uptimeSeconds: result.uptimeSeconds,
        tokens: result.tokensUsed?.available
          ? result.tokensUsed.value ?? null
          : null,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setDaemonConnected(false);
      setCapabilities({ ...DEFAULT_CAPABILITIES });
    }
  }, [
    rpcCall,
    setDaemonConnected,
    setCapabilities,
    applyDaemonMetrics,
  ]);

  const startPolling = useCallback(
    (interval = 5000) => {
      fetchStatus();
      intervalRef.current = setInterval(fetchStatus, interval);
    },
    [fetchStatus]
  );

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  /**
   * Applies mode only after backend confirms.
   * Rejects when capability is off or RPC fails — no optimistic UI success.
   */
  const setMode = useCallback(
    async (mode: DaemonMode): Promise<SetModeResult> => {
      if (!capabilities.modeSwitching) {
        const msg = "Mode switching is not available (capability off).";
        setLastControlError(msg);
        throw new Error(msg);
      }
      setIsLoading(true);
      setLastControlError(null);
      try {
        const result = await rpcCall<SetModeResult>("daemon.setMode", { mode });
        if (
          result.operation === "rejected_invalid_mode" ||
          result.operation === "rejected_invalid_transition"
        ) {
          throw new Error(result.reason ?? "setMode rejected");
        }
        // Confirm with backend before treating UI as authoritative.
        storeSetMode(result.resultingMode);
        await fetchStatus();
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "setMode failed";
        setLastControlError(msg);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [capabilities.modeSwitching, rpcCall, fetchStatus, storeSetMode, setLastControlError]
  );

  /**
   * Emergency brake: waits for backend result before local UI projection.
   * Partial outcomes surface as errors if complete=false.
   */
  const emergencyBrake = useCallback(async (): Promise<EmergencyBrakeResult> => {
    if (!capabilities.emergencyBrake) {
      const msg = "Emergency brake is not available (capability off).";
      setLastControlError(msg);
      throw new Error(msg);
    }
    setIsLoading(true);
    setLastControlError(null);
    try {
      const result = await rpcCall<EmergencyBrakeResult>("daemon.emergencyBrake");
      setLastBrakeOutcome(result.outcome);

      if (!result.complete) {
        const msg =
          result.message ||
          `Partial emergency brake: ${result.failedCount} failure(s).`;
        setLastControlError(msg);
        // Still project local pause for interrupted work, but do not claim full success.
        applyEmergencyBrakeLocally();
        await fetchStatus();
        throw new Error(msg);
      }

      applyEmergencyBrakeLocally();
      storeSetMode(result.mode);
      await fetchStatus();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "emergencyBrake failed";
      setLastControlError(msg);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [
    capabilities.emergencyBrake,
    rpcCall,
    fetchStatus,
    applyEmergencyBrakeLocally,
    storeSetMode,
    setLastControlError,
    setLastBrakeOutcome,
  ]);

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  return {
    status,
    isLoading,
    error,
    capabilities,
    rpcCall,
    setMode,
    emergencyBrake,
    refresh: fetchStatus,
  };
}
