#!/usr/bin/env node
/**
 * TUI Entry Point
 * Mounts the React/Ink application
 */

import React from 'react';
import { render, useApp, useInput } from 'ink';
import { Layout } from './components/Layout.js';
import { useTuiStore } from './store.js';
import { connectTuiToEventBus } from './adapter.js';
import type { EventBus } from '../daemon/event-bus.js';

interface AppProps {
    eventBus?: EventBus;
    onMessage?: (message: string) => void;
}

function App({ eventBus, onMessage }: AppProps) {
    const { exit } = useApp();
    const addMessage = useTuiStore((s) => s.addMessage);
    const addLog = useTuiStore((s) => s.addLog);

    // Connect to EventBus on mount
    React.useEffect(() => {
        if (eventBus) {
            const cleanup = connectTuiToEventBus(eventBus);
            return cleanup;
        }
    }, [eventBus]);

    // Handle Ctrl+C
    useInput((input, key) => {
        if (key.ctrl && input === 'c') {
            exit();
        }
    });

    // Handle user input submission
    const handleSubmit = (value: string) => {
        // Add to chat as user message
        addMessage({
            role: 'user',
            content: value,
            timestamp: new Date(),
        });

        addLog({
            level: 'info',
            message: `User: ${value}`,
            timestamp: new Date(),
            source: 'input',
        });

        // Call external handler if provided
        if (onMessage) {
            onMessage(value);
        }
    };

    return <Layout onSubmit={handleSubmit} />;
}

/**
 * Render the TUI
 */
export function renderTui(eventBus?: EventBus, onMessage?: (msg: string) => void) {
    const { unmount, waitUntilExit } = render(
        <App eventBus={eventBus} onMessage={onMessage} />
    );

    return { unmount, waitUntilExit };
}

/**
 * Standalone entry for testing
 */
export async function main() {
    const store = useTuiStore.getState();

    // Add welcome message
    store.addMessage({
        role: 'system',
        content: '🐍 Welcome to Ouroboros TUI! Type /help for commands.',
        timestamp: new Date(),
    });

    store.addLog({
        level: 'info',
        message: 'TUI initialized',
        timestamp: new Date(),
        source: 'system',
    });

    const { waitUntilExit } = renderTui(undefined, (msg) => {
        // Echo for testing
        setTimeout(() => {
            store.addMessage({
                role: 'agent',
                content: `I received: "${msg}"`,
                timestamp: new Date(),
            });
        }, 500);
    });

    await waitUntilExit();
}

// Run if executed directly
const isMainModule = process.argv[1]?.endsWith('entry.tsx') ||
    process.argv[1]?.endsWith('entry.js');
if (isMainModule) {
    main().catch(console.error);
}
