/**
 * TUI Store
 * Zustand state management for the terminal UI
 */

import { create } from 'zustand';
import type { LogEntry, ChatMessage, TuiStatus, TuiMetrics } from './types.js';

interface TuiState {
    // State
    logs: LogEntry[];
    messages: ChatMessage[];
    status: TuiStatus;
    metrics: TuiMetrics;
    inputValue: string;
    currentTask?: string;

    // Actions
    addLog: (log: Omit<LogEntry, 'id'>) => void;
    addMessage: (msg: Omit<ChatMessage, 'id'>) => void;
    setStatus: (status: TuiStatus) => void;
    updateMetrics: (metrics: Partial<TuiMetrics>) => void;
    setInputValue: (value: string) => void;
    setCurrentTask: (task: string | undefined) => void;
    clearLogs: () => void;
}

const MAX_LOGS = 100;
const MAX_MESSAGES = 50;

function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useTuiStore = create<TuiState>((set) => ({
    // Initial state
    logs: [],
    messages: [],
    status: 'idle',
    metrics: { tokens: 0, cost: 0, uptime: 0 },
    inputValue: '',
    currentTask: undefined,

    // Actions
    addLog: (log) => set((state) => ({
        logs: [...state.logs.slice(-MAX_LOGS + 1), { ...log, id: generateId() }]
    })),

    addMessage: (msg) => set((state) => ({
        messages: [...state.messages.slice(-MAX_MESSAGES + 1), { ...msg, id: generateId() }]
    })),

    setStatus: (status) => set({ status }),

    updateMetrics: (metrics) => set((state) => ({
        metrics: { ...state.metrics, ...metrics }
    })),

    setInputValue: (inputValue) => set({ inputValue }),

    setCurrentTask: (currentTask) => set({ currentTask }),

    clearLogs: () => set({ logs: [] }),
}));
