/**
 * StatusBar Component
 * Footer with status indicator and metrics
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTuiStore } from '../store.js';
import type { TuiStatus } from '../types.js';

const STATUS_COLORS: Record<TuiStatus, string> = {
    idle: 'green',
    thinking: 'yellow',
    executing: 'cyan',
    error: 'red',
};

const STATUS_ICONS: Record<TuiStatus, string> = {
    idle: '●',
    thinking: '◐',
    executing: '▶',
    error: '✖',
};

export function StatusBar(): React.ReactElement {
    const { status, metrics } = useTuiStore();

    const color = STATUS_COLORS[status];
    const icon = STATUS_ICONS[status];
    const costFormatted = `$${metrics.cost.toFixed(4)}`;

    return (
        <Box
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
            justifyContent="space-between"
        >
            <Box gap={2}>
                <Text color={color} bold>
                    {icon} {status.toUpperCase()}
                </Text>
            </Box>
            <Box gap={3}>
                <Text dimColor>
                    TOKENS: <Text color="cyan">{metrics.tokens}</Text>
                </Text>
                <Text dimColor>
                    COST: <Text color="green">{costFormatted}</Text>
                </Text>
            </Box>
        </Box>
    );
}
