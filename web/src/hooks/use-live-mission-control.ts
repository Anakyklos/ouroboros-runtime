import { useEffect, useState, useCallback } from "react";
import { useMissionControlStore, type Wave, type CouncilDebate } from "@/stores/mission-control-store";

/**
 * Hook that connects to live daemon events via the EventBus
 * and updates the Mission Control store in real-time
 */
export function useLiveMissionControl() {
  const [waves, setWaves] = useState<Wave[]>([]);
  const [currentDebate, setCurrentDebate] = useState<CouncilDebate | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const store = useMissionControlStore();

  const handleDaemonEvent = useCallback((event: CustomEvent) => {
    const { type, data } = event.detail;

    switch (type) {
      case "wave:created":
        setWaves((prev) => [...prev, data as Wave]);
        break;

      case "wave:updated":
        setWaves((prev) =>
          prev.map((w) => (w.id === (data as Wave).id ? { ...w, ...data } : w))
        );
        break;

      case "task:progress":
        setWaves((prev) =>
          prev.map((w) =>
            w.id === data.waveId
              ? {
                  ...w,
                  tasks: w.tasks.map((t) =>
                    t.id === data.taskId ? { ...t, ...data.updates } : t
                  ),
                }
              : w
          )
        );
        break;

      case "council:debate_started":
        setCurrentDebate(data as CouncilDebate);
        break;

      case "council:vote":
        setCurrentDebate((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            agents: [...prev.agents, data.agent],
          };
        });
        break;

      case "council:consensus":
        setCurrentDebate((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            consensus: data.consensus,
          };
        });
        break;

      case "daemon:connected":
        setIsConnected(true);
        break;

      case "daemon:disconnected":
        setIsConnected(false);
        break;
    }
  }, []);

  useEffect(() => {
    window.addEventListener("daemon:event", handleDaemonEvent as EventListener);
    return () => {
      window.removeEventListener("daemon:event", handleDaemonEvent as EventListener);
    };
  }, [handleDaemonEvent]);

  return {
    waves,
    currentDebate,
    isConnected,
    stats: {
      waveNumber: store.waveNumber,
      activeTasks: store.activeTasks,
      tasksDone: store.tasksDone,
      uptime: store.uptime,
      tokens: store.tokens,
    },
  };
}