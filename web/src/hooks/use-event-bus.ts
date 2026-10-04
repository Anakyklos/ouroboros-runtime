import { useCallback, useEffect, useRef, useState } from "react";
import { useLogStore } from "@/stores/log-store";
import { useMissionControlStore, type DaemonCapabilities } from "@/stores/mission-control-store";
import { useDaemonProjectionStore } from "@/stores/daemon-projection-store";
import { DaemonWebSocketConnection } from "@/lib/daemon-websocket-connection";
import type {
  AllowedDaemonEvent,
  DaemonEventEnvelope,
  DaemonEventDataMap,
  DaemonSnapshot,
  ProtocolDiagnostic,
} from "../../../shared/daemon-event-contract";

interface UseEventBusOptions {
  url?: string;
  maxReconnectAttempts?: number;
}

type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

function toStoreCapabilities(snapshot: DaemonSnapshot): DaemonCapabilities {
  return {
    statusMetrics: snapshot.capabilities.statusMetrics,
    modeSwitching: snapshot.capabilities.modeSwitching,
    emergencyBrake: snapshot.capabilities.emergencyBrake,
    tokenMetrics: snapshot.capabilities.tokenMetrics,
    brakeRecoverable: snapshot.capabilities.brakeRecoverable,
    modePersistence: snapshot.capabilities.modePersistence,
    supportedModes: [...snapshot.capabilities.supportedModes],
  };
}

function metricValue(metric: DaemonSnapshot["status"]["activeTasks"]): number | undefined {
  return metric.available ? metric.value : undefined;
}

export function toDaemonEventDetail(envelope: DaemonEventEnvelope): {
  event: AllowedDaemonEvent;
  data: DaemonEventEnvelope["data"];
  envelope: DaemonEventEnvelope;
} {
  return {
    event: envelope.event,
    data: envelope.data,
    envelope,
  };
}

export function useEventBus(options: UseEventBusOptions = {}) {
  const {
    url = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`,
    maxReconnectAttempts = 10,
  } = options;

  const connectionRef = useRef<DaemonWebSocketConnection | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");

  const addLogEntry = useLogStore((state) => state.addEntry);
  const setDaemonConnected = useMissionControlStore((state) => state.setDaemonConnected);
  const setCapabilities = useMissionControlStore((state) => state.setCapabilities);
  const applyDaemonMetrics = useMissionControlStore((state) => state.applyDaemonMetrics);
  const replaceDaemonProjection = useDaemonProjectionStore((state) => state.replaceFromSnapshot);
  const applyDaemonProjectionEnvelope = useDaemonProjectionStore((state) => state.applyEnvelope);

  const handleSnapshot = useCallback((snapshot: DaemonSnapshot) => {
    const status = snapshot.status;
    replaceDaemonProjection(snapshot);
    setCapabilities(toStoreCapabilities(snapshot));
    applyDaemonMetrics({
      mode: status.mode,
      activeTasks: metricValue(status.activeTasks),
      activeWaves: metricValue(status.activeWaves),
      uptimeSeconds: status.uptimeSeconds,
      tokens: status.tokensUsed.available ? status.tokensUsed.value : null,
    });
  }, [applyDaemonMetrics, replaceDaemonProjection, setCapabilities]);

  const handleEnvelope = useCallback((envelope: DaemonEventEnvelope) => {
    applyDaemonProjectionEnvelope(envelope);

    if (envelope.event === "log") {
      const payload = envelope.data as DaemonEventDataMap["log"];
      addLogEntry({
        level: payload.level,
        message: payload.message,
        source: payload.source ?? "daemon",
      });
    }

    if (envelope.event !== "snapshot") {
      window.dispatchEvent(new CustomEvent("daemon:event", {
        detail: toDaemonEventDetail(envelope),
      }));
    }
  }, [addLogEntry, applyDaemonProjectionEnvelope]);

  const handleDiagnostic = useCallback((diagnostic: ProtocolDiagnostic) => {
    console.warn(`[EventBus] WebSocket protocol diagnostic: ${diagnostic.code}`);
  }, []);

  const connect = useCallback(() => {
    if (connectionRef.current) return;

    const connection = new DaemonWebSocketConnection({
      url,
      maxReconnectAttempts,
      onStatus: (status) => {
        setConnectionStatus(status);
        setDaemonConnected(status === "connected");
      },
      onSnapshot: handleSnapshot,
      onEnvelope: handleEnvelope,
      onDiagnostic: handleDiagnostic,
    });
    connectionRef.current = connection;
    connection.start();
  }, [handleDiagnostic, handleEnvelope, handleSnapshot, maxReconnectAttempts, setDaemonConnected, url]);

  const disconnect = useCallback(() => {
    const connection = connectionRef.current;
    connectionRef.current = null;
    connection?.disconnect();
    setDaemonConnected(false);
    setConnectionStatus("disconnected");
  }, [setDaemonConnected]);

  const send = useCallback((data: unknown) => {
    if (!connectionRef.current?.send(data)) {
      console.warn("[EventBus] Cannot send - not connected");
    }
  }, []);

  useEffect(() => {
    connect();
    return disconnect;
  }, [connect, disconnect]);

  return {
    send,
    connect,
    disconnect,
    isConnected: useMissionControlStore((state) => state.daemonConnected),
    connectionStatus,
  };
}
