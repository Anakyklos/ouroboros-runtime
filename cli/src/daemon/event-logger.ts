/**
 * 📋 Event Logger
 * 
 * Shared logging utility via EventBus.
 * Extraído de DaemonCoordinator, BackgroundConsciousness, EvolutionScheduler,
 * SafeRestart, PriorityTaskQueue para eliminar duplicação DRY.
 * 
 * Cada componente cria um logger com seu source name,
 * e usa o mesmo contrato de emissão de eventos.
 */

import type { EventBus } from './event-bus.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
    level: LogLevel;
    message: string;
    timestamp: Date;
    source: string;
}

/**
 * Cria uma função de logging via EventBus.
 * 
 * @example
 * const log = createEventLogger('DaemonCoordinator', eventBus);
 * log('info', 'Starting...');
 * log('warn', 'Something unexpected');
 */
export function createEventLogger(
    source: string,
    eventBus: EventBus,
): (level: LogLevel, message: string) => void {
    return (level: LogLevel, message: string) => {
        eventBus.emit('log', {
            level,
            message,
            timestamp: new Date(),
            source,
        });
    };
}
