/**
 * Ouroboros Runtime - Channel ActionExecutor (Gateway)
 * Roteamento e orquestração do IM Plugins para o Ouroboros Daemon/Council.
 */

import type { GatewayOrchestrator } from '../../orchestration/GatewayOrchestrator.js';
import type { OrchestratorTask } from '../../orchestration/types.js';
import type { EventBus } from '../../daemon/event-bus.js';
import type {
    IMChannelPlugin,
    IChannelPluginConfig,
    IUnifiedIncomingMessage,
    IUnifiedOutgoingMessage
} from '../../ports/IChannelPlugin.js';

export interface ActionContext {
    message: IUnifiedIncomingMessage;
    plugin: IMChannelPlugin;
    userId: string;
    chatId: string;
}

export type ActionHandler = (context: ActionContext) => Promise<void>;

export class ChannelGateway {
    private plugins = new Map<string, IMChannelPlugin>();
    private messageHandler: (msg: IUnifiedIncomingMessage) => Promise<void>;

    constructor() {
        this.messageHandler = this.handleIncomingMessage.bind(this);
    }

    public registerPlugin(plugin: IMChannelPlugin) {
        this.plugins.set(plugin.type, plugin);
        plugin.onMessage(this.messageHandler);
        plugin.onConfirm(this.handleToolConfirm.bind(this));
    }

    private async handleIncomingMessage(msg: IUnifiedIncomingMessage) {
        const plugin = this.plugins.get(msg.platform);
        if (!plugin) return;

        // TODO: Connect to Ouroboros `AssistantService` or `Council` 
        // to map to the correct agent context based on msg.chatId.

        if (msg.content.type === 'action' || msg.content.type === 'command') {
            await this.handleActionMessage(msg, plugin);
            return;
        }

        // Default chat message flow
        const thinkingMsgId = await plugin.sendMessage(msg.chatId, {
            text: '⏳ Memoriazzando...'
        });

        try {
            // Simulate Agent streaming
            setTimeout(async () => {
                await plugin.editMessage(msg.chatId, thinkingMsgId, {
                    text: `Mensagem recebida no Gateway Ouroboros: ${msg.content.text}`
                });
            }, 1500);
        } catch (e) {
            console.error(e);
        }
    }

    private async handleActionMessage(msg: IUnifiedIncomingMessage, plugin: IMChannelPlugin) {
        // Process actions like settings, help, agent switches.
        console.log(`Received System action: ${msg.action?.name}`);
    }

    private async handleToolConfirm(userId: string, platform: string, callId: string, value: string) {
        // Pipe confirmation back to the active Tool call in Ouroboros.
        console.log(`Tool ${callId} executed by ${userId}@${platform} with ${value}`);
    }
}
