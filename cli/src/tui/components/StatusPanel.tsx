import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { TuiStatus, TuiMetrics, WaveState, WaveTask } from '../types.js';

interface StatusPanelProps {
    status: TuiStatus;
    metrics: TuiMetrics;
    currentTask?: string;
    activeWave?: WaveState;
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

function TaskIcon({ status }: { status: WaveTask['status'] }) {
    switch (status) {
        case 'completed':
            return <Text color="green">✓</Text>;
        case 'running':
            return <Text color="cyan"><Spinner type="dots" /></Text>;
        case 'failed':
            return <Text color="red">✖</Text>;
        case 'pending':
        default:
            return <Text color="gray">⏳</Text>;
    }
}

function ProgressBar({ current, total, width = 20 }: { current: number; total: number; width?: number }) {
    if (total === 0) {
         return (
            <Text>
                [
                <Text color="gray">{'░'.repeat(width)}</Text>
                ]
            </Text>
        );
    }
    const percentage = Math.min(Math.max(current / total, 0), 1);
    const filled = Math.round(width * percentage);
    const empty = width - filled;

    return (
        <Text>
            [
            <Text color="green">{'█'.repeat(filled)}</Text>
            <Text color="gray">{'░'.repeat(empty)}</Text>
            ]
        </Text>
    );
}

export function StatusPanel({ status, metrics, currentTask, activeWave }: StatusPanelProps) {
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
            {activeWave && (
                <Box flexDirection="column" paddingTop={1} borderStyle="single" borderColor="blue" paddingX={1}>
                    <Box justifyContent="space-between">
                         <Text bold>Wave {activeWave.index}/{activeWave.total}</Text>
                         <ProgressBar
                            current={activeWave.tasks.filter(t => t.status === 'completed').length}
                            total={activeWave.tasks.length}
                         />
                    </Box>
                    <Box flexDirection="column" paddingTop={1}>
                        {activeWave.tasks.map(task => (
                            <Box key={task.id}>
                                <Box marginRight={1}>
                                    <TaskIcon status={task.status} />
                                </Box>
                                <Text color={task.status === 'running' ? 'cyan' : task.status === 'failed' ? 'red' : 'white'}>
                                    {task.name}
                                </Text>
                            </Box>
                        ))}
                    </Box>
                </Box>
            )}
        </Box>
    );
}
