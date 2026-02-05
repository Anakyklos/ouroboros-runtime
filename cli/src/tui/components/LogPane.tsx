/**
 * LogPane Component
 * Right panel showing system logs with auto-scroll
 */

import React from 'react';
import { Box, Text, Newline } from 'ink';
import { format } from 'date-fns';
import { useTuiStore } from '../store.js';
import type { LogEntry } from '../types.js';

const LEVEL_COLORS: Record<LogEntry['level'], string> = {
    debug: 'gray',
    info: 'blue',
    warn: 'yellow',
    error: 'red',
    exec: 'magenta',
};

const LEVEL_LABELS: Record<LogEntry['level'], string> = {
    debug: 'DBG',
    info: 'INF',
    warn: 'WRN',
    error: 'ERR',
    exec: 'EXE',
};

interface LogLineProps {
    log: LogEntry;
}

function LogLine({ log }: LogLineProps): React.ReactElement {
    const time = format(log.timestamp, 'HH:mm:ss');
    const color = LEVEL_COLORS[log.level];
    const label = LEVEL_LABELS[log.level];

    return (
        <Box>
            <Text dimColor>{time} </Text>
            <Text color={color} bold>[{label}] </Text>
            <Text wrap="truncate-end">{log.message}</Text>
        </Box>
    );
}

interface LogPaneProps {
    maxHeight?: number;
}

export function LogPane({ maxHeight = 15 }: LogPaneProps): React.ReactElement {
    const logs = useTuiStore((s) => s.logs);
    const visibleLogs = logs.slice(-maxHeight);

    return (
        <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
            flexGrow={1}
            height={maxHeight + 2}
        >
            <Box marginBottom={1}>
                <Text color="yellow" bold>🛠️ SYSTEM LOGS</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
                {visibleLogs.length === 0 ? (
                    <Text dimColor italic>No logs yet...</Text>
                ) : (
                    visibleLogs.map((log) => <LogLine key={log.id} log={log} />)
                )}
            </Box>
        </Box>
    );
}
