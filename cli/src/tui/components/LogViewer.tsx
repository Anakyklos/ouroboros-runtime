import React from 'react';
import { Box, Text } from 'ink';
import { LogEntry } from '../types.js';

interface LogViewerProps {
    logs: LogEntry[];
    maxHeight?: number;
    autoScroll?: boolean;
}

const formatTime = (date: Date | string) => {
    try {
        const d = typeof date === 'string' ? new Date(date) : date;
        return d.toISOString().split('T')[1].split('.')[0];
    } catch (e) {
        return '00:00:00';
    }
};

function LevelText({ level }: { level: LogEntry['level'] }) {
    let color: string | undefined;
    switch (level) {
        case 'info': color = 'blue'; break;
        case 'warn': color = 'yellow'; break;
        case 'error': color = 'red'; break;
        case 'exec': color = 'green'; break;
        case 'debug': color = 'gray'; break;
        default: color = 'white';
    }
    return <Text color={color}>{level.toUpperCase().padEnd(5)}</Text>;
}

export function LogViewer({ logs, maxHeight = 10, autoScroll = true }: LogViewerProps) {
    const visibleLogs: LogEntry[] = React.useMemo(() => {
        // Simple slice for performance
        // If we have more logs than maxHeight, take the last maxHeight
        const start = Math.max(0, logs.length - maxHeight);
        return logs.slice(start);
    }, [logs, maxHeight, autoScroll]);

    return (
        <Box flexDirection="column">
            {visibleLogs.map((log) => (
                <Box key={log.id} flexDirection="row">
                    <Text dimColor>
                        {formatTime(log.timestamp)}
                    </Text>
                    <Text color="gray"> | </Text>
                    <LevelText level={log.level} />
                    <Text color="gray"> | </Text>
                    {log.source && (
                        <>
                            <Text color="magenta">{log.source}</Text>
                            <Text color="gray"> | </Text>
                        </>
                    )}
                    <Text>{log.message}</Text>
                </Box>
            ))}
        </Box>
    );
}
