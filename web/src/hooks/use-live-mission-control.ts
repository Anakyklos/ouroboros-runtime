/**
 * 🔄 useLiveMissionControl
 *
 * Hook que mantém o Mission Control store sincronizado com o daemon backend.
 *
 * Estratégia desta fase: polling HTTP via RPC (sem WebSocket).
 * - O daemon não implementa WebSocket nesta fase.
 * - Sessions do daemon são usadas como fonte de verdade para execuções ativas.
 * - Waves locais (Zustand) representam planejamento local.
 * - Sessions reais do daemon representam execuções reais.
 *
 * O hook NÃO usa window.dispatchEvent de eventos WS porque esses eventos
 * nunca chegam (EventBus backend é in-process, sem canal externo).
 */

import { useEffect, useCallback, useState } from "react";
import {
  useMissionControlStore,
  type DaemonSession,
  type Wave,
  type Task,
} from "@/stores/mission-control-store";

/**
 * Converte uma DaemonSession em uma Wave do Zustand (execução real).
 *
 * Mapeamento:
 * - session.status = "active" → wave.status = "active"
 * - session.status = "completed" → wave.status = "done"
 * - outros → wave.status = "pending"
 */
function sessionToWave(session: DaemonSession, index: number): Wave {
  const status = (() => {
    if (session.status === "active") return "active" as const;
    if (session.status === "completed") return "done" as const;
    return "pending" as const;
  })();

  const tasks: Task[] = session.metadata?.tasks
    ? (session.metadata.tasks as Array<{ id: string; title: string; progress: number; phase: string }>)
        .map((t) => ({
          id: t.id,
          title: t.title,
          progress: t.progress ?? 0,
          phase: (t.phase ?? "planning") as Task["phase"],
        }))
    : [];

  return {
    id: `session-${session.id}`,
    number: index + 1,
    status,
    tasks,
    title: `Session ${session.id.slice(0, 8)}`,
    isLocal: false,
  };
}

export function useLiveMissionControl() {
  const store = useMissionControlStore();

  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);

  /**
   * Sincroniza sessions do daemon → waves reais no store.
   *
   * Estratégia de merge:
   * - Waves com `isLocal: true` são preservadas (criadas localmente, ainda não enviadas ao daemon)
   * - Waves com `isLocal: false` são substituídas pelas sessions reais
   */
  const syncSessionsToWaves = useCallback(() => {
    const { daemonSessions, waves } = useMissionControlStore.getState();

    if (!daemonSessions || daemonSessions.length === 0) {
      // Sem sessions do daemon — preservar apenas waves locais
      return;
    }

    const localWaves = waves.filter((w) => w.isLocal !== false);
    const realWaves = daemonSessions.map((s, i) => sessionToWave(s, i));

    // Combinar: waves locais primeiro, depois as reais do daemon
    const merged = [...localWaves, ...realWaves];

    // Só atualizar se houve mudança real (evitar re-render desnecessário)
    const currentIds = waves.map((w) => w.id).join(",");
    const newIds = merged.map((w) => w.id).join(",");

    if (currentIds !== newIds) {
      // Atualizar o store com as waves combinadas
      useMissionControlStore.setState({ waves: merged });
      setLastSyncAt(new Date());
    }
  }, []);

  // Reagir a mudanças nas sessions do daemon
  useEffect(() => {
    return useMissionControlStore.subscribe(
      (state, prevState) => {
        if (state.daemonSessions !== prevState.daemonSessions) {
          syncSessionsToWaves();
        }
      }
    );
  }, [syncSessionsToWaves]);

  return {
    waves: store.waves,
    connectionStatus: store.connectionStatus,
    lastSuccessfulPoll: store.lastSuccessfulPoll,
    lastSyncAt,
    daemonSessions: store.daemonSessions,
    agentBridgeStatus: store.agentBridgeStatus,
    agentsStatusTimedOut: store.agentsStatusTimedOut,
    stats: {
      waveNumber: store.waveNumber,
      activeTasks: store.activeTasks,
      tasksDone: store.tasksDone,
      uptime: store.uptime,
      tokens: store.tokens,
    },
  };
}