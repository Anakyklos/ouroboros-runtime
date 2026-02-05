import React from 'react';
import { Box, Text } from 'ink';
import { Markdown } from './Markdown.js';
import { useTypewriter } from '../hooks/useTypewriter.js';
import type { ChatMessage, LogEntry } from '../types.js';

export type TimelineItem =
    | ({ type: 'message' } & ChatMessage)
    | ({ type: 'log' } & LogEntry);

interface MessageItemProps {
    item: TimelineItem;
    isLast: boolean;
}

export function MessageItem({ item, isLast }: MessageItemProps): React.ReactElement {
    if (item.type === 'log') {
        return (
            <Box marginLeft={2} marginBottom={0}>
                <Text color="#F0C674" dimColor>
                    {'⚡ '} {item.message}
                </Text>
            </Box>
        );
    }

    const { role, content } = item;

    // User Message
    if (role === 'user') {
        return (
            <Box flexDirection="column" marginTop={1} marginBottom={0}>
                <Text color="#81A2BE" bold>
                    {'> '} {content}
                </Text>
            </Box>
        );
    }

    // Agent Message
    if (role === 'agent') {
        const textToRender = useTypewriter(content, 10, isLast);

        return (
            <Box flexDirection="column" marginTop={0} marginBottom={1} paddingLeft={2}>
                <Box>
                     <Markdown>{textToRender}</Markdown>
                </Box>
            </Box>
        );
    }

    // System Message
    return (
        <Box marginTop={0} marginBottom={0} marginLeft={2}>
            <Text color="gray" italic>
                {content}
            </Text>
        </Box>
    );
}
