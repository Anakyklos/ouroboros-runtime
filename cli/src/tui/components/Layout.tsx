/**
 * Layout Component
 * Main grid layout with 2-column design
 */

import React from 'react';
import { Box } from 'ink';
import { ChatPane } from './ChatPane.js';
import { LogPane } from './LogPane.js';
import { InputBar } from './InputBar.js';
import { StatusBar } from './StatusBar.js';

interface LayoutProps {
    onSubmit: (value: string) => void;
}

export function Layout({ onSubmit }: LayoutProps): React.ReactElement {
    return (
        <Box flexDirection="column" width="100%">
            {/* Main content area - 2 columns */}
            <Box flexDirection="row" flexGrow={1}>
                {/* Left: Chat/Agent */}
                <Box width="50%">
                    <ChatPane maxHeight={15} />
                </Box>
                {/* Right: Logs */}
                <Box width="50%">
                    <LogPane maxHeight={15} />
                </Box>
            </Box>
            {/* Bottom: Input + Status */}
            <InputBar onSubmit={onSubmit} />
            <StatusBar />
        </Box>
    );
}
