import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { EventBus } from './event-bus.js';
import { RpcGateway } from './rpc-gateway.js';
import type { StoragePort } from '../ports/storage.port.js';

describe('headless RPC shutdown request', () => {
    afterEach(() => {
        mock.restore();
    });

    it('asks the injected lifecycle owner to shut down without exiting the process', async () => {
        const exit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
        const requestShutdown = mock(() => {});
        const gateway = new RpcGateway(
            {} as StoragePort,
            new EventBus(),
            undefined,
            undefined,
            undefined,
            requestShutdown,
        );

        const response = await gateway.handleRequest({
            jsonrpc: '2.0',
            id: 'shutdown-test',
            method: 'system.shutdown',
        });

        expect(response).toMatchObject({
            jsonrpc: '2.0',
            id: 'shutdown-test',
            result: { status: 'shutting_down' },
        });
        await new Promise((resolve) => setTimeout(resolve, 125));
        expect(requestShutdown).toHaveBeenCalledTimes(1);
        expect(exit).not.toHaveBeenCalled();
    });
});
