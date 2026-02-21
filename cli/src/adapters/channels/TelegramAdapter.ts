/**
 * Ouroboros Runtime - Telegram Plugin Adapter
 * Utilizes grammY, ported from AionUi _extracted/components/channels/plugins/telegram/TelegramPlugin.ts
 */

import { Bot } from 'grammy';
import type { Context, SessionFlavor } from 'grammy';
import type {
    IMChannelPlugin,
    IChannelPluginConfig,
    BotInfo,
    PluginStatus,
    PluginType,
    IUnifiedIncomingMessage,
    IUnifiedOutgoingMessage
} from '../../ports/IChannelPlugin.js';

export class TelegramPlugin implements IMChannelPlugin {
    readonly type: PluginType = 'telegram';
    status: PluginStatus = 'created';

    private bot: Bot | null = null;
    private botInfo: BotInfo | null = null;
    private messageHandler?: (msg: IUnifiedIncomingMessage) => Promise<void>;
    private confirmHandler?: (userId: string, platform: string, callId: string, value: string) => Promise<void>;

    async initialize(config: IChannelPluginConfig): Promise<void> {
        if (!config.credentials?.token) {
            throw new Error('Telegram bot token is required');
        }
        this.status = 'initializing';
        this.bot = new Bot(config.credentials.token);
        this.status = 'ready';
    }

    async start(): Promise<void> {
        if (!this.bot) throw new Error('Bot not initialized');
        this.status = 'starting';

        this.bot.on('message:text', async (ctx) => {
            if (this.messageHandler) {
                const msg = this.mapToUnified(ctx);
                if (msg) void this.messageHandler(msg);
            }
        });

        this.bot.on('callback_query:data', async (ctx) => {
            if (this.confirmHandler && ctx.callbackQuery.data) {
                const data = ctx.callbackQuery.data;
                const parts = data.split(':');
                // pattern: confirm:{callId}:{value}
                if (parts[0] === 'confirm' && parts.length >= 3) {
                    const userId = ctx.from.id.toString();
                    const callId = parts[1];
                    const value = parts.slice(2).join(':');

                    await this.confirmHandler(userId, this.type, callId, value);
                    try {
                        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
                    } catch (e) { } // ignore
                    await ctx.answerCallbackQuery();
                }
            }
        });

        this.bot.catch((err) => {
            console.error(`[TelegramPlugin] Bot Error:`, err);
        });

        // Run without awaiting to keep background polling
        this.bot.start({
            onStart: (info) => {
                this.status = 'running';
                this.botInfo = {
                    id: info.id.toString(),
                    username: info.username,
                    displayName: info.first_name
                };
                console.log(`[TelegramPlugin] Polling started as @${info.username}`);
            },
            drop_pending_updates: true
        }).catch(e => {
            this.status = 'error';
            console.error(e);
        });
    }

    async stop(): Promise<void> {
        this.status = 'stopping';
        if (this.bot) {
            await this.bot.stop();
            this.bot = null;
        }
        this.status = 'stopped';
    }

    onMessage(handler: (message: IUnifiedIncomingMessage) => Promise<void>): void {
        this.messageHandler = handler;
    }

    onConfirm(handler: (userId: string, platform: string, callId: string, value: string) => Promise<void>): void {
        this.confirmHandler = handler;
    }

    async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
        if (!this.bot) throw new Error('Not running');
        const result = await this.bot.api.sendMessage(chatId, message.text || '');
        return result.message_id.toString();
    }

    async editMessage(chatId: string, messageId: string, message: IUnifiedOutgoingMessage): Promise<void> {
        if (!this.bot) throw new Error('Not running');
        try {
            await this.bot.api.editMessageText(chatId, parseInt(messageId), message.text || '');
        } catch (e: any) {
            if (!e.message?.includes('message is not modified')) {
                throw e;
            }
        }
    }

    getBotInfo(): BotInfo | null {
        return this.botInfo;
    }

    private mapToUnified(ctx: Context): IUnifiedIncomingMessage | null {
        if (!ctx.from || !ctx.message || !ctx.message.text) return null;

        return {
            id: ctx.message.message_id.toString(),
            platform: this.type,
            chatId: ctx.chat?.id.toString() || ctx.from.id.toString(),
            user: {
                id: ctx.from.id.toString(),
                username: ctx.from.username,
                displayName: ctx.from.first_name
            },
            content: {
                type: 'text',
                text: ctx.message.text
            },
            timestamp: ctx.message.date * 1000
        };
    }
}
