import { create } from "zustand";

/** Modes with real backend effects (frenzy removed — scenic-only). */
export type DaemonMode = "pause" | "running";
export type ViewMode = "grid" | "focused";
export type Quadrant = 1 | 2 | 3 | 4 | null;

export interface Task {
  id: string;
  title: string;
  description?: string;
  progress: number;
  phase: "planning" | "coding" | "testing" | "reviewing" | "complete" | "paused" | "stuck";
  createdAt?: string;
  updatedAt?: string;
}

export interface Wave {
  id: string;
  number: number;
  status: "pending" | "active" | "done";
  tasks: Task[];
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

/** Mirrors backend DaemonCapabilities (issue #37). */
export interface DaemonCapabilities {
  statusMetrics: boolean;
  modeSwitching: boolean;
  emergencyBrake: boolean;
  tokenMetrics: boolean;
  brakeRecoverable?: boolean;
  modePersistence?: boolean;
  supportedModes?: DaemonMode[];
}

export const DEFAULT_CAPABILITIES: DaemonCapabilities = {
  statusMetrics: false,
  modeSwitching: false,
  emergencyBrake: false,
  tokenMetrics: false,
  brakeRecoverable: false,
  modePersistence: false,
  supportedModes: [],
};

interface MissionControlState {
  mode: DaemonMode;
  confidence: number;

  waveNumber: number;
  activeTasks: number;
  tasksDone: number;
  uptime: string;
  /** Only set when backend tokenMetrics is available; never invent scenic usage. */
  tokens: number | null;

  waves: Wave[];
  currentDebate: CouncilDebate | null;

  daemonConnected: boolean;
  capabilities: DaemonCapabilities;
  lastControlError: string | null;
  lastBrakeOutcome: string | null;

  activeQuadrant: Quadrant;
  viewMode: ViewMode;

  setMode: (mode: DaemonMode) => void;
  setConfidence: (value: number) => void;

  updateWave: (waveId: string, updates: Partial<Wave>) => void;
  updateTask: (waveId: string, taskId: string, updates: Partial<Task>) => void;

  setCurrentDebate: (debate: CouncilDebate | null) => void;

  setDaemonConnected: (connected: boolean) => void;
  setCapabilities: (capabilities: DaemonCapabilities) => void;
  setLastControlError: (error: string | null) => void;
  setLastBrakeOutcome: (outcome: string | null) => void;
  applyDaemonMetrics: (metrics: {
    mode?: DaemonMode;
    activeTasks?: number;
    activeWaves?: number;
    uptimeSeconds?: number;
    tokens?: number | null;
  }) => void;

  setWaveNumber: (number: number) => void;
  addWave: (wave: Wave) => void;

  setActiveQuadrant: (quadrant: Quadrant) => void;
  setViewMode: (mode: ViewMode) => void;

  /**
   * Local UI projection after a confirmed emergency brake.
   * Does not call the daemon — only updates wave task phases for display.
   */
  applyEmergencyBrakeLocally: () => void;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export const useMissionControlStore = create<MissionControlState>((set) => ({
  mode: "running",
  confidence: 80,

  waveNumber: 0,
  activeTasks: 0,
  tasksDone: 0,
  uptime: "0h 0m",
  tokens: null,

  waves: [],
  currentDebate: null,

  daemonConnected: false,
  capabilities: { ...DEFAULT_CAPABILITIES },
  lastControlError: null,
  lastBrakeOutcome: null,

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

  setCurrentDebate: (debate) => set({ currentDebate: debate }),

  setDaemonConnected: (connected) => set({ daemonConnected: connected }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setLastControlError: (error) => set({ lastControlError: error }),
  setLastBrakeOutcome: (outcome) => set({ lastBrakeOutcome: outcome }),

  applyDaemonMetrics: (metrics) =>
    set((state) => ({
      mode: metrics.mode ?? state.mode,
      activeTasks: metrics.activeTasks ?? state.activeTasks,
      waveNumber: metrics.activeWaves ?? state.waveNumber,
      uptime:
        metrics.uptimeSeconds !== undefined
          ? formatUptime(metrics.uptimeSeconds)
          : state.uptime,
      tokens: metrics.tokens !== undefined ? metrics.tokens : state.tokens,
    })),

  setWaveNumber: (waveNumber) => set({ waveNumber }),

  addWave: (wave) =>
    set((state) => {
      const exists = state.waves.some((w) => w.id === wave.id);
      const waves = exists
        ? state.waves.map((w) => (w.id === wave.id ? wave : w))
        : [...state.waves, wave];
      return { waves };
    }),

  setActiveQuadrant: (quadrant) => set({ activeQuadrant: quadrant }),
  setViewMode: (mode) => set({ viewMode: mode }),

  applyEmergencyBrakeLocally: () =>
    set((state) => ({
      mode: "pause",
      waves: state.waves.map((w) => ({
        ...w,
        status: w.status === "active" ? "pending" : w.status,
        tasks: w.tasks.map((t) => ({
          ...t,
          phase: t.phase === "complete" ? "complete" : "paused",
        })),
      })),
    })),
}));
