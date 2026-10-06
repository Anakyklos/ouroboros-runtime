import { describe, expect, it, mock } from 'bun:test';

mock.module('../orchestration/GatewayOrchestrator.js', () => {
    throw new Error('headless composition loaded GatewayOrchestrator');
});
mock.module('../providers/agent-loop.js', () => {
    throw new Error('headless composition loaded createAgent');
});
mock.module('../orchestration/Orchestrator.js', () => {
    throw new Error('headless composition loaded Orchestrator');
});
mock.module('../orchestration/WaveExecutor.js', () => {
    throw new Error('headless composition loaded WaveExecutor');
});
mock.module('../bridges/GeminiCliBridge.js', () => {
    throw new Error('headless composition loaded Gemini bridge');
});
mock.module('../bridges/AntigravityBridge.js', () => {
    throw new Error('headless composition loaded Antigravity bridge');
});
mock.module('../bridges/JulesBridge.js', () => {
    throw new Error('headless composition loaded Jules bridge');
});
mock.module('./legacy-rpc-gateway.js', () => {
    throw new Error('headless composition loaded legacy RPC gateway');
});

describe('default headless composition', () => {
    it('constructs the daemon server without importing legacy execution modules', async () => {
        const { DaemonServer } = await import('./server.js');
        const { EventBus } = await import('./event-bus.js');
        const server = new DaemonServer({} as never, { port: 0 }, new EventBus());

        expect(server).toBeInstanceOf(DaemonServer);
        await server.stop();
    });
});
