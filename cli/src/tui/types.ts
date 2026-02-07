/**
 * TUI Types
 * Type definitions for the terminal UI state
 */

export interface LogEntry {
    id: string;
    level: 'debug' | 'info' | 'warn' | 'error' | 'exec';
    message: string;
    timestamp: Date;
    source?: string;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'agent' | 'system';
    content: string;
    timestamp: Date;
}

export type TuiStatus = 'idle' | 'thinking' | 'executing' | 'error' | 'dispatching';

export interface TuiMetrics {
    tokens: number;
    cost: number;
    uptime: number;
}
