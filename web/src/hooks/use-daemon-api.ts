/**
 * 🔌 useDaemonAPI
 *
 * Hook principal para comunicação com o daemon via JSON-RPC 2.0.
 *
 * Métodos RPC reais disponíveis no daemon:
 *   system.health, system.version, system.shutdown
 *   session.create, session.list, session.get, session.attach
 *   agent.input, agent.interrupt, agent.resume
 *   daemon.delegate, daemon.list_agents
 *
 * Métodos NÃO implementados no daemon (local-only):
 *   daemon.setMode     → atualiza apenas o Zustand store local
 *   daemon.emergencyBrake → atualiza apenas o Zustand store local
 *
 * Canal de eventos: NÃO disponível (sem WS/SSE). Dados via polling a 5-10s.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { toast } from "sonner";
import {
  useMissionControlStore,
  type DaemonSession,
  type AgentBridgeStatus,
} from "@/stores/mission-control-store";

interface DaemonAPIOptions {
  baseUrl?: string;
  /** Intervalo de health polling em ms (default: 5000) */
  healthPollInterval?: number;
  /** Intervalo de session polling em ms (default: 8000) */
  sessionPollInterval?: number;
}

export interface DaemonStatus {
  status: "running" | "paused" | "error";
  uptime: number;
  activeWaves: number;
  activeTasks: number;
  tokensUsed: number;
}

interface HealthResponse {
  status: string;
  uptime: number;
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
  };
  timestamp: string;
}

interface SessionListResponse {
  sessions: DaemonSession[];
}

interface AgentsListResponse {
  agents: Record<string, string>;
  timedOut?: boolean;
  timestamp: string;
}

interface DelegateResponse {
  status: string;
  agent: string;
  result: unknown;
  timestamp: string;
}

export function useDaemonAPI(options: DaemonAPIOptions = {}) {
  const {
    baseUrl = "/api",
    healthPollInterval = 5000,
    sessionPollInterval = 8000,
  } = options;

  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const healthIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const sessionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const baseUrlRef = useRef(baseUrl);
  baseUrlRef.current = baseUrl;

  // ─── RPC Core ───────────────────────────────────────────────────────────

  const rpcCall = useCallback(async <T,>(
    method: string,
    params?: unknown,
    timeoutMs = 15000
  ): Promise<T> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrlRef.current}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`RPC call failed: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error.message || "RPC error");
      }

      return data.result;
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);

  // ─── Health Polling ──────────────────────────────────────────────────────

  const fetchHealth = useCallback(async () => {
    if (!mountedRef.current) return;

    const store = useMissionControlStore.getState();

    try {
      const health = await rpcCall<HealthResponse>("system.health", undefined, 8000);
      if (!mountedRef.current) return;

      const mapped: DaemonStatus = {
        status: health.status === "healthy" ? "running" : "error",
        uptime: Math.floor(health.uptime),
        // Sem dados reais de waves/tasks nesta fase — não fingir
        activeWaves: 0,
        activeTasks: 0,
        tokensUsed: 0,
      };

      setStatus(mapped);
      store.setConnectionStatus("polling");
      store.setLastSuccessfulPoll(new Date());
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      store.setConnectionStatus("disconnected");
    }
  }, [rpcCall]);

  // ─── Session Polling ─────────────────────────────────────────────────────

  const fetchSessions = useCallback(async () => {
    if (!mountedRef.current) return;

    const store = useMissionControlStore.getState();
    // Só buscar sessions se daemon estiver respondendo
    if (
      store.connectionStatus === "disconnected" ||
      store.connectionStatus === "unknown"
    ) {
      return;
    }

    try {
      const result = await rpcCall<SessionListResponse>(
        "session.list",
        {},
        10000
      );
      if (!mountedRef.current) return;
      store.setDaemonSessions(result.sessions ?? []);
    } catch (err) {
      // Session list falhou — não é crítico, não atualiza connectionStatus
      console.warn("[DaemonAPI] session.list falhou:", err instanceof Error ? err.message : err);
    }
  }, [rpcCall]);

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;

    // Initial fetch
    fetchHealth();
    fetchSessions();

    // Polling intervals
    healthIntervalRef.current = setInterval(fetchHealth, healthPollInterval);
    sessionIntervalRef.current = setInterval(fetchSessions, sessionPollInterval);

    return () => {
      mountedRef.current = false;
      if (healthIntervalRef.current) clearInterval(healthIntervalRef.current);
      if (sessionIntervalRef.current) clearInterval(sessionIntervalRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-only — intervals fixos

  // ─── Session Actions ─────────────────────────────────────────────────────

  const createSession = useCallback(async (context?: string): Promise<DaemonSession | null> => {
    try {
      const result = await rpcCall<{ sessionId: string }>("session.create", {
        context: context ?? "",
        metadata: {},
      });
      // Refresh sessions imediatamente após criar
      await fetchSessions();
      return {
        id: result.sessionId,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[DaemonAPI] session.create falhou:", message);
      toast.error(`Falha ao criar sessão: ${message}`);
      return null;
    }
  }, [rpcCall, fetchSessions]);

  const sendInput = useCallback(async (
    sessionId: string,
    prompt: string
  ): Promise<{ taskId: string } | null> => {
    try {
      const result = await rpcCall<{ taskId: string }>("agent.input", {
        sessionId,
        prompt,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[DaemonAPI] agent.input falhou:", message);
      toast.error(`Falha ao enviar input: ${message}`);
      return null;
    }
  }, [rpcCall]);

  // ─── Agent Actions ────────────────────────────────────────────────────────

  /**
   * Busca status dos agentes/bridges disponíveis.
   * Timeout de 12s no cliente (backend tem 8s de timeout próprio).
   * Marca timedOut=true se backend demorar demais.
   */
  const fetchAgents = useCallback(async () => {
    const store = useMissionControlStore.getState();
    try {
      setIsLoading(true);
      const result = await rpcCall<AgentsListResponse>(
        "daemon.list_agents",
        {},
        12000 // cliente: 12s (backend tem 8s de timeout)
      );

      const statusMap: Record<string, AgentBridgeStatus> = {};
      for (const [name, s] of Object.entries(result.agents ?? {})) {
        statusMap[name] = s === "available" ? "available" : "unavailable";
      }

      store.setAgentBridgeStatus(statusMap, result.timedOut ?? false);
    } catch (err) {
      // Timeout ou erro — marcar todos como unknown
      console.warn("[DaemonAPI] daemon.list_agents falhou:", err instanceof Error ? err.message : err);
      store.setAgentBridgeStatus({
        gemini: "unknown",
        antigravity: "unknown",
        claude: "unknown",
        jules: "unknown",
        glm: "unknown",
      }, true);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [rpcCall]);

  /**
   * Delega task a um agente externo.
   * Timeout de 30s no cliente (suficiente para delegation simples).
   * Para GLM wave mode, o timeout é maior (120s).
   */
  const delegateTask = useCallback(async (
    agent: string,
    prompt: string,
    context?: string
  ): Promise<DelegateResponse | null> => {
    const isWaveMode = agent === "glm" && prompt.trim().toUpperCase().startsWith("WAVE:");
    const timeoutMs = isWaveMode ? 120000 : 30000;
    const store = useMissionControlStore.getState();
    const resultId = `del-${Date.now()}`;

    store.setDelegating(true);
    store.addDelegationResult({
      id: resultId,
      agent,
      prompt,
      status: "pending",
      timestamp: new Date().toISOString(),
    });

    try {
      setIsLoading(true);
      const result = await rpcCall<DelegateResponse>(
        "daemon.delegate",
        { agent, prompt, context },
        timeoutMs
      );

      store.addDelegationResult({
        id: resultId,
        agent,
        prompt,
        status: "success",
        result: result.result,
        timestamp: result.timestamp,
      });

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[DaemonAPI] daemon.delegate(${agent}) falhou:`, message);

      store.addDelegationResult({
        id: resultId,
        agent,
        prompt,
        status: "error",
        error: message,
        timestamp: new Date().toISOString(),
      });

      toast.error(`Falha na delegação do agente ${agent}: ${message}`);
      return null;
    } finally {
      store.setDelegating(false);
      if (mountedRef.current) setIsLoading(false);
    }
  }, [rpcCall]);

  // ─── Session Control Actions ──────────────────────────────────────────────

  const interruptSession = useCallback(async (sessionId: string): Promise<boolean> => {
    try {
      await rpcCall<{ status: string }>(
        "agent.interrupt",
        { sessionId },
        10000
      );
      await fetchSessions();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[DaemonAPI] agent.interrupt falhou:", message);
      toast.error(`Falha ao interromper agente: ${message}`);
      return false;
    }
  }, [rpcCall, fetchSessions]);

  const resumeSession = useCallback(async (sessionId: string): Promise<boolean> => {
    try {
      await rpcCall<{ status: string }>(
        "agent.resume",
        { sessionId },
        10000
      );
      await fetchSessions();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[DaemonAPI] agent.resume falhou:", message);
      toast.error(`Falha ao resumir agente: ${message}`);
      return false;
    }
  }, [rpcCall, fetchSessions]);

  // ─── Local-only actions (sem RPC equivalente no daemon) ─────────────────

  const setMode = useCallback(async (mode: "pause" | "running" | "frenzy") => {
    // daemon.setMode NÃO existe no backend — atualiza apenas o store local
    console.warn("[DaemonAPI] daemon.setMode não implementado no daemon — atualizando apenas estado local.");
    useMissionControlStore.getState().setMode(mode);
  }, []);

  const emergencyBrake = useCallback(async () => {
    // daemon.emergencyBrake NÃO existe no backend — atualiza apenas o store local
    console.warn("[DaemonAPI] daemon.emergencyBrake não implementado no daemon — atualizando apenas estado local.");
    useMissionControlStore.getState().emergencyBrake();
  }, []);

  return {
    status,
    isLoading,
    error,
    rpcCall,
    // Session
    createSession,
    sendInput,
    refreshSessions: fetchSessions,
    // Session control
    interruptSession,
    resumeSession,
    // Agents
    fetchAgents,
    delegateTask,
    // Mode (local-only)
    setMode,
    emergencyBrake,
    // Health
    refresh: fetchHealth,
  };
}