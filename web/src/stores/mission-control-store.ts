import { create } from "zustand";

export type DaemonMode = "pause" | "running" | "frenzy";

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
  
  daemonConnected: boolean;
  
  setMode: (mode: DaemonMode) => void;
  setConfidence: (value: number) => void;
  
  updateWave: (waveId: string, updates: Partial<Wave>) => void;
  updateTask: (waveId: string, taskId: string, updates: Partial<Task>) => void;
  
  setCurrentDebate: (debate: CouncilDebate | null) => void;

  setDaemonConnected: (connected: boolean) => void;

  setWaveNumber: (number: number) => void;
  addWave: (wave: Wave) => void;

  emergencyBrake: () => void;
}

export const useMissionControlStore = create<MissionControlState>((set) => ({
  mode: "running",
  confidence: 80,
  
  waveNumber: 42,
  activeTasks: 3,
  tasksDone: 47,
  uptime: "0h 0m",
  tokens: 0,
  
  waves: [],
  currentDebate: null,
  
  daemonConnected: false,
  
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

  setWaveNumber: (waveNumber) => set({ waveNumber }),

  addWave: (wave) => set((state) => ({ waves: [...state.waves, wave] })),

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
}));