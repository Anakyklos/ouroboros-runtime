import { create } from "zustand";

export interface LogEntry {
  id: string;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
}

interface LogState {
  entries: LogEntry[];
  maxEntries: number;
  
  addEntry: (entry: Omit<LogEntry, "id" | "timestamp">) => void;
  clearEntries: () => void;
  getEntriesByLevel: (level: LogEntry["level"]) => LogEntry[];
}

export const useLogStore = create<LogState>((set, get) => ({
  entries: [],
  maxEntries: 500,
  
  addEntry: (entry) =>
    set((state) => {
      const newEntry: LogEntry = {
        ...entry,
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        timestamp: new Date().toISOString(),
      };
      
      const entries = [...state.entries, newEntry];
      
      if (entries.length > state.maxEntries) {
        return { entries: entries.slice(-state.maxEntries) };
      }
      
      return { entries };
    }),
  
  clearEntries: () => set({ entries: [] }),
  
  getEntriesByLevel: (level) => {
    return get().entries.filter((e) => e.level === level);
  },
}));