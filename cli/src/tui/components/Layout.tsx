import React from 'react';
import { Box } from 'ink';
import { MessageList } from './MessageList.js';
import { InputBar } from './InputBar.js';

interface LayoutProps {
    onSubmit: (value: string) => void;
}

export function Layout({ onSubmit }: LayoutProps) {
    return (
        <Box flexDirection="column" width="100%">
            <MessageList />
            <Box paddingTop={1}>
                <InputBar onSubmit={onSubmit} />
            </Box>
        </Box>
    );
}
