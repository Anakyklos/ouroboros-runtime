import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import gradient from 'gradient-string';
import { LogViewer } from './LogViewer.js';
import { StatusPanel } from './StatusPanel.js';
import { InputBar } from './InputBar.js';
import { CouncilPanel } from './CouncilPanel.js';
import { useTuiStore } from '../store.js';

interface LayoutProps {
    onSubmit: (value: string) => void;
}

const HEADER_HEIGHT = 3; // Box border + text
const STATUS_HEIGHT = 6; // Panel height
const INPUT_HEIGHT = 3;  // Input bar height

export function Layout({ onSubmit }: LayoutProps) {
    const { stdout } = useStdout();
    const { logs, status, metrics, currentTask } = useTuiStore();

    const logHeight = useMemo(() => {
        // Safe default if stdout is not available or too small
        const totalHeight = stdout?.rows || 24;
        const available = totalHeight - HEADER_HEIGHT - STATUS_HEIGHT - INPUT_HEIGHT;
        return Math.max(5, available);
    }, [stdout?.rows]);

    return (
        <Box flexDirection="column" height="100%">
            {/* Header */}
            <Box borderStyle="round" borderColor="cyan" paddingX={1}>
                <Text>{gradient.pastel('Ouroboros v1.0')}</Text>
            </Box>

            {/* Council Panel */}
            <CouncilPanel />

            {/* Status Panel */}
            <StatusPanel status={status} metrics={metrics} currentTask={currentTask} />

            {/* Log Viewer - Flexible Height */}
            <Box flexGrow={1} borderStyle="round" borderColor="gray" flexDirection="column">
                <LogViewer logs={logs} maxHeight={logHeight} autoScroll={true} />
            </Box>

            {/* Input Bar - Fixed Bottom */}
            <Box borderStyle="round" borderColor="blue" paddingX={1}>
                <InputBar onSubmit={onSubmit} />
            </Box>
        </Box>
    );
}
