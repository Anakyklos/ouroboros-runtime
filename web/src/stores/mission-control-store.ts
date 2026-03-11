import { create } from "zustand";

export type DaemonMode = "pause" | "running" | "frenzy";
export type ViewMode = "grid" | "focused";
export type Quadrant = 1 | 2 | 3 | 4 | null;

/**
 * Estado de conexão granular com o daemon.
 *
 * - `connected`: health OK + daemon respondendo via RPC
 * - `polling`: health OK — em modo polling HTTP (sem canal de eventos push)
 * - `disconnected`: daemon não responde ao health check
 * - `error`: daemon responde mas com erro
 * - `unknown`: estado inicial, ainda não foi feita primeira tentativa
 */
export type ConnectionStatus =
  | "connected"
  | "polling"
  | "disconnected"
  | "error"
  | "unknown";

/**
 * Status de um agente externo (bridge).
 * - `available`: bridge respondeu positivamente
 * - `unavailable`: bridge não encontrada ou erro
 * - `unknown`: não verificado ainda ou timeout
 */
export type AgentBridgeStatus = "available" | "unavailable" | "unknown";

export interface Task {
  id: string;
  title: string;
  progress: number;
  phase: "planning" | "coding" | "testing" | "reviewing" | "complete" | "paused" | "stuck";
}

export interface Wave {
  id: string;
  number: number;
  status: "pending" | "active" | "done";
  tasks: Task[];
  title?: string;
  /** Se true, esta wave foi criada localmente e ainda não foi enviada ao daemon */
  isLocal?: boolean;
}

export interface AgentVote {
  name: string;
  avatar: string;
  stance: "approve" | "warn" | "reject";
  message: string;
}

export interface CouncilDebate {
  topic: string;
  consensus: number;
  agents: AgentVote[];
  autoMergeIn?: number;
}

interface Idea {
  id: string;
  type: "code_improvements" | "ui_ux" | "security" | "performance";
  title: string;
  confidence: number;
}

/** Sessão real do daemon */
export interface DaemonSession {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

interface MissionControlState {
  mode: DaemonMode;
  confidence: number;

  waveNumber: number;
  activeTasks: number;
  tasksDone: number;
  uptime: string;
  tokens: number;

  waves: Wave[];
  currentDebate: CouncilDebate | null;
  /** Alias usado pelo TheCouncil component */
  activeDebate: CouncilDebate | null;

  /** Files atualmente sendo escaneados por TheEye */
  scanningFiles: string[];
  /** Ideas geradas pela análise (TheEye) */
  ideas: Idea[];

  /**
   * Estado de conexão granular.
   * Substitui o boolean `daemonConnected` para comunicar o estado real.
   */
  connectionStatus: ConnectionStatus;

  /**
   * @deprecated Use `connectionStatus` em vez deste boolean.
   * Mantido para compatibilidade com componentes ainda não migrados.
   */
  daemonConnected: boolean;

  /** Timestamp do último polling bem-sucedido */
  lastSuccessfulPoll: Date | null;

  /** Sessões reais do daemon, atualizadas via polling de session.list */
  daemonSessions: DaemonSession[];

  /** Status dos agentes/bridges externos (resultado de daemon.list_agents) */
  agentBridgeStatus: Record<string, AgentBridgeStatus>;

  /** Se true, daemon.list_agents retornou timeout */
  agentsStatusTimedOut: boolean;

  activeQuadrant: Quadrant;
  viewMode: ViewMode;

  // Actions
  setMode: (mode: DaemonMode) => void;
  setConfidence: (value: number) => void;

  updateWave: (waveId: string, updates: Partial<Wave>) => void;
  updateTask: (waveId: string, taskId: string, updates: Partial<Task>) => void;

  setCurrentDebate: (debate: CouncilDebate | null) => void;

  /** @deprecated Use setConnectionStatus */
  setDaemonConnected: (connected: boolean) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setLastSuccessfulPoll: (date: Date) => void;

  setWaveNumber: (number: number) => void;
  addWave: (wave: Wave) => void;

  setActiveQuadrant: (quadrant: Quadrant) => void;
  setViewMode: (mode: ViewMode) => void;

  emergencyBrake: () => void;

  /** Atualiza sessões reais do daemon */
  setDaemonSessions: (sessions: DaemonSession[]) => void;

  /** Atualiza status dos agentes/bridges */
  setAgentBridgeStatus: (
    status: Record<string, AgentBridgeStatus>,
    timedOut?: boolean
  ) => void;
}

export const useMissionControlStore = create<MissionControlState>((set) => ({
  mode: "running",
  confidence: 80,

  waveNumber: 0,
  activeTasks: 0,
  tasksDone: 0,
  uptime: "0h 0m",
  tokens: 0,

  waves: [],
  currentDebate: null,
  activeDebate: null,

  scanningFiles: [],
  ideas: [],

  connectionStatus: "unknown",
  daemonConnected: false,
  lastSuccessfulPoll: null,

  daemonSessions: [],

  agentBridgeStatus: {},
  agentsStatusTimedOut: false,

  activeQuadrant: null,
  viewMode: "grid",

  setMode: (mode) => set({ mode }),
  setConfidence: (confidence) => set({ confidence }),

  updateWave: (waveId, updates) =>
    set((state) => ({
      waves: state.waves.map((w) =>
        w.id === waveId ? { ...w, ...updates } : w
      ),
    })),

  updateTask: (waveId, taskId, updates) =>
    set((state) => ({
      waves: state.waves.map((w) =>
        w.id === waveId
          ? {
              ...w,
              tasks: w.tasks.map((t) =>
                t.id === taskId ? { ...t, ...updates } : t
              ),
            }
          : w
      ),
    })),

  setCurrentDebate: (debate) => set({ currentDebate: debate, activeDebate: debate }),

  setDaemonConnected: (connected) =>
    set({
      daemonConnected: connected,
      connectionStatus: connected ? "polling" : "disconnected",
    }),

  setConnectionStatus: (status) =>
    set({
      connectionStatus: status,
      // Manter daemonConnected em sync para compatibilidade
      daemonConnected: status === "connected" || status === "polling",
    }),

  setLastSuccessfulPoll: (date) => set({ lastSuccessfulPoll: date }),

  setWaveNumber: (waveNumber) => set({ waveNumber }),

  addWave: (wave) => set((state) => ({ waves: [...state.waves, wave] })),

  setActiveQuadrant: (quadrant) => set({ activeQuadrant: quadrant }),
  setViewMode: (mode) => set({ viewMode: mode }),

  emergencyBrake: () =>
    set((state) => ({
      mode: "pause",
      waves: state.waves.map((w) => ({
        ...w,
        tasks: w.tasks.map((t) => ({
          ...t,
          phase: t.phase === "complete" ? "complete" : "paused",
        })),
      })),
    })),

  setDaemonSessions: (sessions) => set({ daemonSessions: sessions }),

  setAgentBridgeStatus: (status, timedOut = false) =>
    set({ agentBridgeStatus: status, agentsStatusTimedOut: timedOut }),
}));