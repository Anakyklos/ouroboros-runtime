/**
 * ChatPane Component
 * Left panel showing agent conversation history
 */

import React from 'react';
import { Box, Text } from 'ink';
import { format } from 'date-fns';
import { useTuiStore } from '../store.js';
import type { ChatMessage } from '../types.js';

const ROLE_STYLES: Record<ChatMessage['role'], { prefix: string; color: string }> = {
    user: { prefix: '> You:', color: 'green' },
    agent: { prefix: '< Agent:', color: 'cyan' },
    system: { prefix: '! System:', color: 'yellow' },
};

interface MessageLineProps {
    message: ChatMessage;
}

function MessageLine({ message }: MessageLineProps): React.ReactElement {
    const style = ROLE_STYLES[message.role];

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Text color={style.color} bold>{style.prefix}</Text>
            <Text wrap="wrap">{message.content}</Text>
        </Box>
    );
}

interface ChatPaneProps {
    maxHeight?: number;
}

export function ChatPane({ maxHeight = 15 }: ChatPaneProps): React.ReactElement {
    const messages = useTuiStore((s) => s.messages);
    // Show latest messages that fit
    const visibleMessages = messages.slice(-10);

    return (
        <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="cyan"
            paddingX={1}
            flexGrow={1}
            height={maxHeight + 2}
        >
            <Box marginBottom={1}>
                <Text color="cyan" bold>🧠 AGENT MIND</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
                {visibleMessages.length === 0 ? (
                    <Text dimColor italic>Start a conversation...</Text>
                ) : (
                    visibleMessages.map((msg) => <MessageLine key={msg.id} message={msg} />)
                )}
            </Box>
        </Box>
    );
}
