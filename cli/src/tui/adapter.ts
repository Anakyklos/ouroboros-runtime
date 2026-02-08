/**
 * TUI Adapter
 * Bridge between EventBus and Zustand store
 */

import type { EventBus, LogEvent, ThoughtEvent, TaskEvent, WaveEvent } from '../daemon/event-bus.js';
import { useTuiStore } from './store.js';

/**
 * Connect the TUI to the EventBus
 * Maps daemon events to UI state updates
 */
export function connectTuiToEventBus(bus: EventBus): () => void {
    const store = useTuiStore.getState();
    const unsubscribers: Array<() => void> = [];

    // Log events -> LogPane
    unsubscribers.push(
        bus.on('log', (event: LogEvent) => {
            store.addLog({
                level: event.level,
                message: event.message,
                timestamp: event.timestamp,
                source: event.source,
            });
        })
    );

    // Thought events -> ChatPane (agent messages)
    unsubscribers.push(
        bus.on('thought', (event: ThoughtEvent) => {
            // Only show reasoning and decisions as chat messages
            if (event.type === 'reasoning' || event.type === 'decision') {
                store.addMessage({
                    role: 'agent',
                    content: event.content,
                    timestamp: event.timestamp,
                });
            }
            // Tool calls go to logs
            if (event.type === 'tool_call' || event.type === 'tool_result') {
                store.addLog({
                    level: 'exec',
                    message: event.content,
                    timestamp: event.timestamp,
                    source: 'tool',
                });
            }
        })
    );

    // Task events -> Status updates
    unsubscribers.push(
        bus.on('task', (event: TaskEvent) => {
            switch (event.type) {
                case 'started':
                    store.setStatus('executing');
                    if (event.data && typeof event.data === 'object' && 'description' in event.data) {
                        store.setCurrentTask((event.data as any).description);
                    }
                    break;
                case 'progress':
                    store.setStatus('thinking');
                    break;
                case 'completed':
                    store.setStatus('idle');
                    store.setCurrentTask(undefined);
                    break;
                case 'failed':
                    store.setStatus('error');
                    store.setCurrentTask(undefined);
                    break;
            }
        })
    );

    // Wave events -> Store
    unsubscribers.push(
        bus.on('wave', (event: WaveEvent) => {
            store.setActiveWave({
                id: event.waveId,
                index: event.waveIndex,
                total: event.totalWaves,
                tasks: event.tasks
            });
        })
    );

    // Return cleanup function
    return () => {
        unsubscribers.forEach((unsub) => unsub());
    };
}
