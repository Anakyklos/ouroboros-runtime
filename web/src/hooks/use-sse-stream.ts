/**
 * 📡 useSSEStream / useAgentStream — Honest No-Op (Phase 1)
 *
 * O daemon NÃO implementa SSE. Não existe endpoint `/api/stream/{id}`.
 *
 * Esta implementação é um no-op explícito:
 * - Não tenta conectar a nenhum endpoint SSE
 * - Retorna estado de erro claro: "streaming_not_available"
 *
 * Phase 2: implementar quando daemon tiver endpoint GET /api/stream/{sessionId}
 * com EventSource server-side + bridge do EventBus interno.
 */

import { useState } from "react";

export interface SSEStreamState {
  isConnected: false;
  lastEvent: null;
  error: "streaming_not_available";
}

const NOT_AVAILABLE_STATE: SSEStreamState = {
  isConnected: false,
  lastEvent: null,
  error: "streaming_not_available",
};

/**
 * Hook para streaming SSE de respostas do daemon.
 *
 * Estado atual: no-op. SSE não implementado no daemon.
 */
export function useSSEStream(_options: {
  url: string;
  onMessage?: (data: unknown) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
  reconnectOnError?: boolean;
  reconnectInterval?: number;
}) {
  return {
    ...NOT_AVAILABLE_STATE,
    connect: () => {
      console.warn("[SSEStream] Streaming não disponível — daemon não implementa SSE.");
    },
    disconnect: () => {},
  };
}

/**
 * Hook para streaming de respostas de agentes via SSE.
 *
 * Estado atual: no-op. Endpoint `/api/stream/{sessionId}` não existe no daemon.
 * Para obter respostas de agentes, use `agent.input` via RPC e aguarde o resultado.
 */
export function useAgentStream(_sessionId: string | null) {
  const [chunks] = useState<string[]>([]);
  const [fullResponse] = useState("");

  return {
    chunks,
    fullResponse,
    isStreaming: false,
    isConnected: false,
    notAvailable: true,
    error: "streaming_not_available" as const,
    startStream: () => {
      console.warn("[AgentStream] Streaming não disponível — daemon não implementa SSE. Use agent.input via RPC.");
    },
    stopStream: () => {},
  };
}