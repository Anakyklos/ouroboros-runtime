import React from 'react';
import { Box, Text } from 'ink';
import { Markdown } from './Markdown.js';
import { useTypewriter } from '../hooks/useTypewriter.js';
import type { ChatMessage, LogEntry } from '../types.js';
import { colors, icons } from '../theme.js';

export type TimelineItem =
    | ({ type: 'message' } & ChatMessage)
    | ({ type: 'log' } & LogEntry);

interface MessageItemProps {
    item: TimelineItem;
    isLast: boolean;
}

export function MessageItem({ item, isLast }: MessageItemProps) {
    if (item.type === 'log') {
        const logColor = item.level === 'error' ? colors.ruby
            : item.level === 'warn' ? colors.gold
                : colors.emeraldMuted;

        return (
            <Box marginLeft={2} marginBottom={0}>
                <Text color={logColor} dimColor>
                    {icons.bolt} {item.message}
                </Text>
            </Box>
        );
    }

    const { role, content } = item;

    // User Message - Gold bolt
    if (role === 'user') {
        return (
            <Box flexDirection="column" marginTop={1} marginBottom={0}>
                <Text color={colors.gold} bold>
                    {icons.bolt} You:
                </Text>
                <Box marginLeft={2}>
                    <Text color={colors.pearl}>{content}</Text>
                </Box>
            </Box>
        );
    }

    // Agent Message - Emerald snake
    if (role === 'agent') {
        const textToRender = useTypewriter(content, 5, isLast);

        return (
            <Box flexDirection="column" marginTop={0} marginBottom={1} paddingLeft={2}>
                <Text color={colors.emerald}>
                    {icons.snake} Ouroboros:
                </Text>
                <Box marginLeft={2}>
                    <Markdown>{textToRender}</Markdown>
                </Box>
            </Box>
        );
    }

    // System Message - Silver muted
    return (
        <Box marginTop={0} marginBottom={0} marginLeft={2}>
            <Text color={colors.silver} italic>
                {icons.info} {content}
            </Text>
        </Box>
    );
}
