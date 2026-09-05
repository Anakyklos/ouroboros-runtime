import { create } from "zustand";
import {
  applyDaemonEnvelope,
  initialDaemonProjectionState,
  replaceFromSnapshot,
  type DaemonProjectionState,
} from "@/lib/daemon-projection";
import type {
  DaemonEventEnvelope,
  DaemonSnapshot,
} from "../../../shared/daemon-event-contract";

export interface DaemonProjectionStoreState {
  projection: DaemonProjectionState;
  replaceFromSnapshot: (snapshot: DaemonSnapshot) => void;
  applyEnvelope: (envelope: DaemonEventEnvelope) => void;
  reset: () => void;
}

/** Zustand container for the daemon's observational projection only. */
export const useDaemonProjectionStore = create<DaemonProjectionStoreState>((set) => ({
  projection: initialDaemonProjectionState,
  replaceFromSnapshot: (snapshot) => set({ projection: replaceFromSnapshot(snapshot) }),
  applyEnvelope: (envelope) => set((state) => ({
    projection: applyDaemonEnvelope(state.projection, envelope),
  })),
  reset: () => set({ projection: initialDaemonProjectionState }),
}));
