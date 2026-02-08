import React from 'react';
import { Box, Text } from 'ink';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

interface CouncilSignal {
    mission?: string;
    turn: string;
    previousTurn?: string;
    status?: string;
    message?: string;
    autoInvoke?: boolean;
    last_update?: string;
}

const AGENT_EMOJIS: Record<string, string> = {
    wyvern: '🦅',
    amphisbaena: '🐍🐍',
    leviathan: '🌊',
    basilisk: '🐉',
};

const AGENT_NAMES: Record<string, string> = {
    wyvern: 'Wyvern',
    amphisbaena: 'Amphisbaena',
    leviathan: 'Leviathan',
    basilisk: 'Basilisk',
};

function readSignal(): CouncilSignal | null {
    const signalPath = path.join(process.cwd(), '..', 'COUNCIL_SIGNAL.json');

    if (!existsSync(signalPath)) {
        return null;
    }

    try {
        return JSON.parse(readFileSync(signalPath, 'utf-8'));
    } catch {
        return null;
    }
}

function formatUptime(lastUpdate?: string): string {
    if (!lastUpdate) return 'Unknown';

    const now = new Date();
    const then = new Date(lastUpdate);
    const diff = now.getTime() - then.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);

    if (minutes > 0) return `${minutes}m ago`;
    return `${seconds}s ago`;
}

export function CouncilPanel() {
    const signal = readSignal();

    if (!signal) {
        return (
            <Box borderStyle="single" borderColor="gray" paddingX={1} paddingY={0}>
                <Text dimColor>🐍 Council: Offline</Text>
            </Box>
        );
    }

    const emoji = AGENT_EMOJIS[signal.turn] || '🤖';
    const name = AGENT_NAMES[signal.turn] || signal.turn;
    const updateTime = formatUptime(signal.last_update);

    return (
        <Box borderStyle="single" borderColor="cyan" paddingX={1} paddingY={0} flexDirection="column">
            <Box justifyContent="space-between">
                <Text bold color="cyan">🐍 COUNCIL</Text>
                <Text dimColor>{updateTime}</Text>
            </Box>
            <Box>
                <Text>
                    <Text bold>Turn:</Text> {emoji} <Text color="yellow">{name}</Text>
                </Text>
            </Box>
            {signal.message && (
                <Box>
                    <Text dimColor>Task: {signal.message.substring(0, 50)}{signal.message.length > 50 ? '...' : ''}</Text>
                </Box>
            )}
        </Box>
    );
}
