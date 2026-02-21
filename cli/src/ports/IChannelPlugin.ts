/**
 * Ouroboros Runtime - Channel Plugin Ports
 * Defines shapes for dynamically loaded IM channels (Telegram, Lark, etc)
 */

export interface IUnifiedIncomingMessage {
    id: string;
    platform: string;
    chatId: string;
    user: {
        id: string;
        username?: string;
        displayName?: string;
    };
    content: {
        type: 'text' | 'image' | 'file' | 'action' | 'command';
        text?: string;
        url?: string;
    };
    action?: {
        type: 'system' | 'platform' | 'chat';
        name: string;
    };
    timestamp: number;
}

export interface IUnifiedOutgoingMessage {
    text?: string;
    replyMarkup?: any; // To allow platform-specific extensions if needed
}

export type PluginStatus = 'created' | 'initializing' | 'ready' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
export type PluginType = 'telegram' | 'lark' | 'dingtalk' | 'wechat' | 'slack' | 'custom';

export interface BotInfo {
    id: string;
    username?: string;
    displayName?: string;
}

export interface IChannelPluginConfig {
    credentials?: Record<string, string>;
    options?: Record<string, any>;
}

export interface IMChannelPlugin {
    readonly type: PluginType;
    status: PluginStatus;

    initialize(config: IChannelPluginConfig): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;

    onMessage(handler: (message: IUnifiedIncomingMessage) => Promise<void>): void;
    onConfirm(handler: (userId: string, platform: string, callId: string, value: string) => Promise<void>): void;

    sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string>;
    editMessage(chatId: string, messageId: string, message: IUnifiedOutgoingMessage): Promise<void>;

    getBotInfo(): BotInfo | null;
}

