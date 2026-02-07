import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { TuiStatus, TuiMetrics } from '../types.js';

interface StatusPanelProps {
    status: TuiStatus;
    metrics: TuiMetrics;
    currentTask?: string;
}

function StatusIndicator({ status }: { status: TuiStatus }) {
    switch (status) {
        case 'idle':
            return <Text color="green">● IDLE</Text>;
        case 'thinking':
            return (
                <Text color="yellow">
                    <Spinner type="dots" /> THINKING
                </Text>
            );
        case 'dispatching':
            return (
                <Text color="magenta">
                    <Spinner type="dots" /> DISPATCHING
                </Text>
            );
        case 'executing':
            return (
                <Text color="cyan">
                    <Spinner type="line" /> EXECUTING
                </Text>
            );
        case 'error':
            return <Text color="red">✖ ERROR</Text>;
        default:
            return <Text color="gray">UNKNOWN</Text>;
    }
}

export function StatusPanel({ status, metrics, currentTask }: StatusPanelProps) {
    return (
        <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="gray">
            <Box flexDirection="row" justifyContent="space-between">
                <Box>
                    <StatusIndicator status={status} />
                </Box>
                <Box>
                    <Text dimColor>
                        Tokens: {metrics.tokens.toLocaleString()} | Cost: ${metrics.cost.toFixed(4)}
                    </Text>
                </Box>
            </Box>
            {currentTask && (
                <Box paddingTop={1}>
                    <Text>
                        <Text bold>Task:</Text> {currentTask}
                    </Text>
                </Box>
            )}
        </Box>
    );
}
