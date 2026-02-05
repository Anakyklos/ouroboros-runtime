/**
 * InputBar Component
 * User input capture with command support
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useTuiStore } from '../store.js';

interface InputBarProps {
    onSubmit: (value: string) => void;
}

export function InputBar({ onSubmit }: InputBarProps): React.ReactElement {
    const [value, setValue] = useState('');
    const status = useTuiStore((s) => s.status);
    const isDisabled = status === 'thinking' || status === 'executing';

    const handleSubmit = (input: string) => {
        const trimmed = input.trim();
        if (trimmed && !isDisabled) {
            onSubmit(trimmed);
            setValue('');
        }
    };

    return (
        <Box
            borderStyle="single"
            borderColor={isDisabled ? 'gray' : 'blue'}
            paddingX={1}
        >
            <Text color="blue" bold>⌨️ </Text>
            {isDisabled ? (
                <Text dimColor>Agent is working...</Text>
            ) : (
                <TextInput
                    value={value}
                    onChange={setValue}
                    onSubmit={handleSubmit}
                    placeholder="Type a message or /help for commands..."
                />
            )}
        </Box>
    );
}
