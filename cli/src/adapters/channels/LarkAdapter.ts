/**
 * Ouroboros Runtime - Lark Plugin Adapter
 * Utilizes @larksuiteoapi/node-sdk, ported from AionUi _extracted/components/channels/plugins/lark/LarkPlugin.ts
 */

import * as lark from '@larksuiteoapi/node-sdk';
import type {
    IMChannelPlugin,
    IChannelPluginConfig,
    BotInfo,
    PluginStatus,
    PluginType,
    IUnifiedIncomingMessage,
    IUnifiedOutgoingMessage
} from '../../ports/IChannelPlugin.js';

export class LarkPlugin implements IMChannelPlugin {
    readonly type: PluginType = 'lark';
    status: PluginStatus = 'created';

    private client: lark.Client | null = null;
    private wsClient: lark.WSClient | null = null;
    private eventDispatcher: lark.EventDispatcher | null = null;
    private botInfo: BotInfo | null = null;

    private messageHandler?: (msg: IUnifiedIncomingMessage) => Promise<void>;
    private confirmHandler?: (userId: string, platform: string, callId: string, value: string) => Promise<void>;

    async initialize(config: IChannelPluginConfig): Promise<void> {
        const { appId, appSecret } = config.credentials || {};
        if (!appId || !appSecret) {
            throw new Error('Lark App ID and App Secret are required');
        }

        this.status = 'initializing';
        this.client = new lark.Client({
            appId,
            appSecret,
            appType: lark.AppType.SelfBuild,
            domain: lark.Domain.Feishu,
        });
        this.botInfo = { id: appId, displayName: 'Lark Assistant' };
        this.status = 'ready';
    }

    async start(): Promise<void> {
        if (!this.client) throw new Error('Client not initialized');
        this.status = 'starting';

        this.eventDispatcher = new lark.EventDispatcher({
            encryptKey: '',
            verificationToken: '',
        });

        this.eventDispatcher.register({
            'im.message.receive_v1': async (data: any) => {
                if (this.messageHandler) {
                    const msg = this.mapToUnified(data);
                    if (msg) void this.messageHandler(msg);
                }
            },
            'card.action.trigger': async (data: any) => {
                const action = data?.event?.action;
                const operator = data?.event?.operator;

                if (action?.value?.action === 'tool_confirm' && this.confirmHandler) {
                    const userId = operator.user_id || operator.open_id;
                    const callId = action.value.callId;
                    const value = action.value.result;
                    if (userId && callId && value) {
                        await this.confirmHandler(userId, this.type, callId, value);
                    }
                }
                return {};
            }
        });

        this.wsClient = new lark.WSClient({
            appId: this.botInfo!.id,
            appSecret: '', // Injected naturally from client config/credentials by Lark if available
            domain: lark.Domain.Feishu,
        });

        this.wsClient.start({ eventDispatcher: this.eventDispatcher }).catch(err => {
            console.error('[LarkPlugin] WS Error:', err);
        });

        this.status = 'running';
    }

    async stop(): Promise<void> {
        this.status = 'stopping';
        if (this.wsClient) {
            // Lark WSClient has no direct stop method. Nullify references.
            this.wsClient = null;
        }
        this.client = null;
        this.status = 'stopped';
    }

    onMessage(handler: (message: IUnifiedIncomingMessage) => Promise<void>): void {
        this.messageHandler = handler;
    }

    onConfirm(handler: (userId: string, platform: string, callId: string, value: string) => Promise<void>): void {
        this.confirmHandler = handler;
    }

    async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
        if (!this.client) throw new Error('Not running');

        // We send a card even for text to allow editing later in Lark
        const card = this.buildTextCard(message.text || '');

        const response = await this.client.im.message.create({
            params: { receive_id_type: this.getReceiveIdType(chatId) },
            data: {
                receive_id: chatId,
                msg_type: 'interactive',
                content: JSON.stringify(card),
            },
        });

        return response.data?.message_id || '';
    }

    async editMessage(chatId: string, messageId: string, message: IUnifiedOutgoingMessage): Promise<void> {
        if (!this.client) throw new Error('Not running');

        const card = this.buildTextCard(message.text || '');
        try {
            await this.client.im.message.patch({
                path: { message_id: messageId },
                data: { content: JSON.stringify(card) },
            });
        } catch (e: any) {
            // Ignore not modified errors
        }
    }

    getBotInfo(): BotInfo | null {
        return this.botInfo;
    }

    private getReceiveIdType(receiveId: string): 'open_id' | 'chat_id' | 'union_id' | 'user_id' {
        if (receiveId.startsWith('ou_')) return 'open_id';
        if (receiveId.startsWith('oc_')) return 'chat_id';
        if (receiveId.startsWith('on_')) return 'union_id';
        return 'user_id';
    }

    private buildTextCard(text: string): Record<string, unknown> {
        return {
            config: { wide_screen_mode: true },
            elements: [{ tag: 'markdown', content: text }],
        };
    }

    private mapToUnified(event: any): IUnifiedIncomingMessage | null {
        const message = event?.event?.message;
        const sender = event?.event?.sender;

        if (!message || !sender) return null;

        const userId = sender.sender_id?.user_id || sender.sender_id?.open_id;
        const isText = message.message_type === 'text';
        let text = '';

        if (isText && message.content) {
            try {
                const parsed = JSON.parse(message.content);
                text = parsed.text || '';
            } catch (e) {
                text = message.content;
            }
        }

        return {
            id: message.message_id,
            platform: this.type,
            chatId: message.chat_id,
            user: {
                id: userId,
                displayName: `LarkUser_${userId.substring(0, 6)}`
            },
            content: {
                type: 'text',
                text: text
            },
            timestamp: parseInt(message.create_time, 10) || Date.now()
        };
    }
}
