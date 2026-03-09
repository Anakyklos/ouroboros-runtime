/**
 * 🌐 Ouroboros Runtime - Channel Gateway
 * 
 * Routes and orchestrates IM Plugins to the Ouroboros Daemon/Council.
 * Bridges incoming messages from Telegram/Lark/DingTalk to the orchestrator.
 */

import type { GatewayOrchestrator } from '../../orchestration/GatewayOrchestrator.js';
import type { OrchestratorTask, TaskResult } from '../../orchestration/types.js';
import { PersonaType, TaskStatus } from '../../orchestration/types.js';
import type { EventBus } from '../../daemon/event-bus.js';
import { globalEventBus } from '../../daemon/event-bus.js';
import type {
    IMChannelPlugin,
    IUnifiedIncomingMessage,
} from '../../ports/IChannelPlugin.js';

export interface ActionContext {
    message: IUnifiedIncomingMessage;
    plugin: IMChannelPlugin;
    userId: string;
    chatId: string;
}

export type ActionHandler = (context: ActionContext) => Promise<void>;

/**
 * Pending tool confirmations awaiting user response.
 */
interface PendingConfirmation {
    taskId: string;
    callId: string;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
}

export class ChannelGateway {
    private plugins = new Map<string, IMChannelPlugin>();
    private orchestrator: GatewayOrchestrator | null = null;
    private eventBus: EventBus;
    private pendingConfirmations = new Map<string, PendingConfirmation>();
    private messageHandler: (msg: IUnifiedIncomingMessage) => Promise<void>;

    /** Timeout for tool confirmations in ms (default: 5 minutes) */
    private confirmationTimeoutMs = 5 * 60 * 1000;

    constructor(orchestrator?: GatewayOrchestrator, eventBus?: EventBus) {
        this.orchestrator = orchestrator ?? null;
        this.eventBus = eventBus ?? globalEventBus;
        this.messageHandler = this.handleIncomingMessage.bind(this);
    }

    /**
     * Set or update the orchestrator after construction.
     */
    public setOrchestrator(orchestrator: GatewayOrchestrator): void {
        this.orchestrator = orchestrator;
        this.log('info', '🔗 ChannelGateway connected to GatewayOrchestrator');
    }

    /**
     * Register an IM channel plugin (Telegram, Lark, DingTalk).
     */
    public registerPlugin(plugin: IMChannelPlugin): void {
        this.plugins.set(plugin.type, plugin);
        plugin.onMessage(this.messageHandler);
        plugin.onConfirm(this.handleToolConfirm.bind(this));
        this.log('info', `📱 Registered channel plugin: ${plugin.type}`);
    }

    /**
     * Unregister a plugin by type.
     */
    public unregisterPlugin(type: string): void {
        this.plugins.delete(type);
        this.log('info', `📱 Unregistered channel plugin: ${type}`);
    }

    /**
     * Get all registered plugin types.
     */
    public getRegisteredPlugins(): string[] {
        return Array.from(this.plugins.keys());
    }

    /**
     * Handle incoming message from any IM channel.
     */
    private async handleIncomingMessage(msg: IUnifiedIncomingMessage): Promise<void> {
        const plugin = this.plugins.get(msg.platform);
        if (!plugin) {
            this.log('warn', `No plugin registered for platform: ${msg.platform}`);
            return;
        }

        // Handle system actions (settings, help, agent switches)
        if (msg.content.type === 'action' || msg.content.type === 'command') {
            await this.handleActionMessage(msg, plugin);
            return;
        }

        // Check if orchestrator is available
        if (!this.orchestrator) {
            this.log('warn', 'ChannelGateway: No orchestrator connected, echoing message');
            await plugin.sendMessage(msg.chatId, {
                text: `⚠️ Orchestrator not connected. Received: ${msg.content.text}`,
            });
            return;
        }

        // Send "thinking" indicator
        const thinkingMsgId = await plugin.sendMessage(msg.chatId, {
            text: '⏳ Processing...',
        });

        try {
            // Create task for orchestrator
            const task: OrchestratorTask = {
                id: `im-${msg.platform}-${Date.now()}`,
                instruction: msg.content.text ?? '',
                persona: PersonaType.DEVELOPER,
                context: JSON.stringify({
                    source: msg.platform,
                    chatId: msg.chatId,
                    userId: msg.user.id,
                    messageId: msg.id,
                }),
            };

            this.log('debug', `📨 Executing task from ${msg.platform}: ${task.id}`);

            // Execute via orchestrator (uses default session)
            const result = await this.orchestrator.executeTask('im-session', task);

            // Format and send response
            const responseText = this.formatTaskResult(result);
            await plugin.editMessage(msg.chatId, thinkingMsgId, {
                text: responseText,
            });

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log('error', `Task execution failed: ${errorMsg}`);
            
            await plugin.editMessage(msg.chatId, thinkingMsgId, {
                text: `❌ Error: ${errorMsg}`,
            });
        }
    }

    /**
     * Handle system action messages (settings, help, etc).
     */
    private async handleActionMessage(
        msg: IUnifiedIncomingMessage,
        plugin: IMChannelPlugin
    ): Promise<void> {
        const actionName = msg.action?.name ?? 'unknown';
        this.log('info', `🎬 Received system action: ${actionName} from ${msg.platform}`);

        switch (actionName) {
            case 'help':
                await plugin.sendMessage(msg.chatId, {
                    text: '🐍 Ouroboros Runtime\n\nAvailable commands:\n• /help - Show this help\n• /status - Check system status\n• /clear - Clear conversation context',
                });
                break;

            case 'status':
                const status = this.orchestrator ? 'connected' : 'disconnected';
                const plugins = this.getRegisteredPlugins().join(', ') || 'none';
                await plugin.sendMessage(msg.chatId, {
                    text: `📊 Status\n\nOrchestrator: ${status}\nPlugins: ${plugins}`,
                });
                break;

            default:
                await plugin.sendMessage(msg.chatId, {
                    text: `⚠️ Unknown action: ${actionName}`,
                });
        }
    }

    /**
     * Handle tool confirmation callback from IM channel.
     */
    private async handleToolConfirm(
        userId: string,
        platform: string,
        callId: string,
        value: string
    ): Promise<void> {
        const confirmKey = `${platform}:${callId}`;
        const pending = this.pendingConfirmations.get(confirmKey);

        if (!pending) {
            this.log('warn', `No pending confirmation for ${confirmKey}`);
            return;
        }

        // Clear timeout and resolve
        clearTimeout(pending.timeout);
        this.pendingConfirmations.delete(confirmKey);
        
        this.log('info', `✅ Tool ${callId} confirmed by ${userId}@${platform}: ${value}`);
        pending.resolve(value);
    }

    /**
     * Request confirmation from a user via IM channel.
     * Returns a promise that resolves when user confirms or rejects when timeout.
     */
    public async requestConfirmation(
        platform: string,
        chatId: string,
        callId: string,
        message: string
    ): Promise<string> {
        const plugin = this.plugins.get(platform);
        if (!plugin) {
            throw new Error(`No plugin registered for platform: ${platform}`);
        }

        // Send confirmation request
        await plugin.sendMessage(chatId, {
            text: `🔔 Confirmation Required\n\n${message}\n\nReply with your choice.`,
        });

        const confirmKey = `${platform}:${callId}`;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingConfirmations.delete(confirmKey);
                reject(new Error(`Confirmation timeout for ${callId}`));
            }, this.confirmationTimeoutMs);

            this.pendingConfirmations.set(confirmKey, {
                taskId: chatId,
                callId,
                resolve,
                reject,
                timeout,
            });
        });
    }

    /**
     * Format task result for display in IM.
     */
    private formatTaskResult(result: TaskResult): string {
        if (result.status === TaskStatus.SUCCESS) {
            const output = result.output ?? 'Task completed successfully.';
            return `✅ ${output}`;
        }

        if (result.status === TaskStatus.FAILURE) {
            return `❌ Task failed: ${result.error ?? 'Unknown error'}`;
        }

        if (result.status === TaskStatus.NEEDS_HUMAN) {
            return `👤 Task requires human review: ${result.output}`;
        }

        return `⏳ Task status: ${result.status}`;
    }

    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        this.eventBus.log(level, message, 'ChannelGateway');
    }
}
