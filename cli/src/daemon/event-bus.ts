/**
 * 📡 EventBus
 * 
 * Sistema de eventos para desacoplar componentes.
 * Substitui console.log direto por eventos tipados.
 */

import { redactText, redactValue } from "../inference/redaction.js";

type EventCallback<T = unknown> = (data: T) => void;

export interface LogEvent {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    timestamp: Date;
    source?: string;
}

export interface TaskEvent {
    type: 'started' | 'progress' | 'completed' | 'failed';
    sessionId: string;
    data?: unknown;
}

export interface DaemonEvent {
    type:
        | 'starting'
        | 'ready'
        | 'shutting_down'
        | 'stopped'
        | 'emergency_brake'
        | 'mode_changed';
    port?: number;
    /** Optional payload for mode / brake diagnostics (issue #37). */
    mode?: string;
    previousMode?: string;
    outcome?: string;
    interruptedCount?: number;
    failedCount?: number;
}

export interface ThoughtEvent {
    type: 'reasoning' | 'tool_call' | 'tool_result' | 'decision';
    sessionId?: string;
    content: string;
    metadata?: Record<string, unknown>;
    timestamp: Date;
}

export interface WaveEvent {
    type: 'wave_started' | 'wave_completed' | 'task_update';
    waveId: string;
    waveIndex: number;
    totalWaves: number;
    tasks: {
        id: string;
        name: string;
        status: 'pending' | 'running' | 'completed' | 'failed';
    }[];
}

export interface BudgetEvent {
    type: 'usage_recorded' | 'threshold_warning' | 'threshold_critical' | 'budget_exceeded';
    model: string;
    costUsd: number;
    totalSpentUsd: number;
    budgetLimitUsd: number;
    usedPct: number;
    timestamp: Date;
}

// Union of all event types
export type EventMap = {
    log: LogEvent;
    task: TaskEvent;
    daemon: DaemonEvent;
    thought: ThoughtEvent;
    wave: WaveEvent;
    budget: BudgetEvent;
    '*': unknown; // Wildcard listener support
};

export class EventBus {
    private listeners: Map<string, Set<EventCallback>> = new Map();
    private redactionSecrets = new Set<string>();

    /**
     * Subscribe to an event type
     */
    on<K extends keyof EventMap>(event: K, callback: EventCallback<EventMap[K]>): () => void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event)!.add(callback as EventCallback);

        // Return unsubscribe function
        return () => this.off(event, callback);
    }

    /**
     * Unsubscribe from an event type
     */
    off<K extends keyof EventMap>(event: K, callback: EventCallback<EventMap[K]>): void {
        this.listeners.get(event)?.delete(callback as EventCallback);
    }

    /**
     * Emit an event
     */
    emit<K extends Exclude<keyof EventMap, '*'>>(event: K, data: EventMap[K]): void {
        const safeData = redactValue(data, [...this.redactionSecrets]) as EventMap[K];

        // Trigger specific listeners
        this.listeners.get(event)?.forEach(callback => {
            try {
                callback(safeData);
            } catch (err) {
                console.error(`[EventBus] Error in ${String(event)} handler:`, redactText(String(err), [...this.redactionSecrets]));
            }
        });

        // Trigger wildcard listeners
        this.listeners.get('*')?.forEach(callback => {
            try {
                callback({ event, data: safeData });
            } catch (err) {
                console.error(`[EventBus] Error in wildcard handler for ${String(event)}:`, redactText(String(err), [...this.redactionSecrets]));
            }
        });
    }

    /** Registra uma chave em memória para redaction exata em eventos futuros. */
    registerRedactionSecret(secret: string): void {
        if (secret) this.redactionSecrets.add(secret);
    }

    /** Remove uma chave da lista de redaction quando o chamador revoga seu registro. */
    revokeRedactionSecret(secret: string): void {
        this.redactionSecrets.delete(secret);
    }

    /**
     * Log helper - emits a log event
     */
    log(level: LogEvent['level'], message: string, source?: string): void {
        this.emit('log', {
            level,
            message,
            timestamp: new Date(),
            source,
        });
    }

    /**
     * Clear all listeners (for testing)
     */
    clear(): void {
        this.listeners.clear();
        this.redactionSecrets.clear();
    }
}

// Singleton instance for global access
export const globalEventBus = new EventBus();
