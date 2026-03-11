/**
 * 📡 useEventBus — Real WebSocket implementation
 *
 * Conecta ao daemon via WebSocket para receber eventos em tempo real
 * (logs, ondas, tarefas, status).
 */

import { useEffect, useState } from "react";
import { useLogStore } from "@/stores/log-store";
import { useMissionControlStore } from "@/stores/mission-control-store";

export type EventBusStatus =
  | "not_available"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

interface UseEventBusOptions {
  url?: string;
}

interface UseEventBusResult {
  isConnected: boolean;
  status: EventBusStatus;
  reason: string;
}

// Module-level singletons to prevent multiple open WS connections across app
let wsInstance: WebSocket | null = null;
let currentStatus: EventBusStatus = "disconnected";
let currentReason = "Não inicializado";

const listeners = new Set<(status: EventBusStatus, reason: string) => void>();

function updateGlobalStatus(newStatus: EventBusStatus, reason: string) {
  currentStatus = newStatus;
  currentReason = reason;
  listeners.forEach(fn => fn(newStatus, reason));
}

export function useEventBus(options: UseEventBusOptions = {}): UseEventBusResult {
  const [status, setStatus] = useState<EventBusStatus>(currentStatus);
  const [reason, setReason] = useState<string>(currentReason);

  useEffect(() => {
    const handler = (s: EventBusStatus, r: string) => { setStatus(s); setReason(r); };
    listeners.add(handler);

    if (!wsInstance && options.url) {
      updateGlobalStatus("connecting", "Tentando conectar ao WebSocket...");

      try {
        wsInstance = new WebSocket(options.url);

        wsInstance.onopen = () => {
          updateGlobalStatus("connected", "Conectado com sucesso");
          useLogStore.getState().addEntry({
            level: "info",
            message: "Conectado ao canal WebSocket de Eventos",
            source: "EventBus",
          });
          useMissionControlStore.getState().setConnectionStatus("connected");
        };

        wsInstance.onmessage = (msgEvent) => {
          try {
            const payload = JSON.parse(msgEvent.data);
            if (!payload || !payload.event || !payload.data) return;

            if (payload.event === "log") {
              useLogStore.getState().addEntry({
                level: payload.data.level || "info",
                message: payload.data.message,
                source: payload.data.source || "Daemon",
              });
            } else if (payload.event === "wave" && payload.data.type === "wave_started") {
              // Simples sync quando a wave logar (já existe polling, mas aqui vem live)
              console.log("[EventBus WS] Wave event received:", payload.data);
            }
          } catch (err) {
            console.error("[EventBus WS] Parse erro:", err);
          }
        };

        wsInstance.onerror = (err) => {
          console.error("[EventBus WS] WebSocket erro:", err);
          updateGlobalStatus("error", "Erro na conexão WebSocket");
        };

        wsInstance.onclose = () => {
          wsInstance = null;
          updateGlobalStatus("disconnected", "Conexão perdida (fechado)");
          useMissionControlStore.getState().setConnectionStatus("disconnected");
        };
      } catch (err) {
        updateGlobalStatus("error", "Falha na construção da conexão WS: " + String(err));
      }
    }

    return () => {
      listeners.delete(handler);
      // Opcional: só fecha quando todos listeners sumirem
      if (listeners.size === 0 && wsInstance) {
        wsInstance.close();
        wsInstance = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.url]);

  return {
    isConnected: status === "connected",
    status,
    reason,
  };
}