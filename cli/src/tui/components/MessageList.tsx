import React, { useMemo } from 'react';
import { Box, Static, Text } from 'ink';
import { useTuiStore } from '../store.js';
import { MessageItem, type TimelineItem } from './MessageItem.js';
import type { LogEntry, ChatMessage } from '../types.js';

export function MessageList() {
    const messages = useTuiStore((s) => s.messages);
    const logs = useTuiStore((s) => s.logs);

    // Combine and sort
    const items: TimelineItem[] = useMemo(() => {
        const msgItems: TimelineItem[] = messages.map(m => ({ type: 'message', ...m }));
        const logItems: TimelineItem[] = logs
            .filter(l => l.level !== 'debug') // Filter out debug
            .map(l => ({ type: 'log', ...l }));

        return [...msgItems, ...logItems].sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
    }, [messages, logs]);

    if (items.length === 0) {
        return (
            <Box padding={1}>
                <Text dimColor>Waiting for input...</Text>
            </Box>
        );
    }

    // Split into history (Static) and active (Dynamic)
    // Actually, purely creating a "Split" might be jittery if we have rapid updates.
    // But for a TUI, it's the standard way to keep the prompt at the bottom.

    // Strategy:
    // If the last item is a MESSAGE from AGENT, keep it active to animate.
    // If the last item is a LOG or USER message, we can arguably "commit" it immediately,
    // BUT keeping the last item always active is a safer generic pattern.

    const history = items.slice(0, -1);
    const active = items[items.length - 1];

    return (
        <Box flexDirection="column" flexGrow={1}>
            <Static items={history}>
                {(item) => (
                    <Box key={item.id}>
                        <MessageItem item={item} isLast={false} />
                    </Box>
                )}
            </Static>

            {/* Active Item */}
            {active && (
                <MessageItem
                    item={active}
                    isLast={true}
                />
            )}
        </Box>
    );
}
