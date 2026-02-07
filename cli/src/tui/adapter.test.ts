import { describe, it, expect, beforeEach } from 'bun:test';
import { EventBus } from '../daemon/event-bus.js';
import { connectTuiToEventBus } from './adapter.js';
import { useTuiStore } from './store.js';

describe('TUI Adapter', () => {
    let bus: EventBus;
    let store: ReturnType<typeof useTuiStore.getState>;

    beforeEach(() => {
        // Reset store and bus
        useTuiStore.setState({
            logs: [],
            messages: [],
            status: 'idle',
            currentTask: undefined
        });
        store = useTuiStore.getState();
        bus = new EventBus();
    });

    it('maps logs events to store', () => {
        connectTuiToEventBus(bus);

        bus.log('info', 'Test log message', 'test-source');

        const state = useTuiStore.getState();
        expect(state.logs).toHaveLength(1);
        expect(state.logs[0].message).toBe('Test log message');
        expect(state.logs[0].source).toBe('test-source');
    });

    it('maps task started event to status and currentTask', () => {
        connectTuiToEventBus(bus);

        bus.emit('task', {
            type: 'started',
            sessionId: '123',
            data: { description: 'Implementing feature X' }
        });

        const state = useTuiStore.getState();
        expect(state.status).toBe('executing');
        // This expectation will fail initially, guiding our implementation
        expect(state.currentTask).toBe('Implementing feature X');
    });

    it('clears currentTask on completion', () => {
        useTuiStore.setState({ currentTask: 'Old Task' });
        connectTuiToEventBus(bus);

        bus.emit('task', {
            type: 'completed',
            sessionId: '123'
        });

        const state = useTuiStore.getState();
        expect(state.status).toBe('idle');
        expect(state.currentTask).toBeUndefined();
    });
});
