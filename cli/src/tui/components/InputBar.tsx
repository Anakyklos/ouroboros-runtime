import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useTuiStore } from '../store.js';
import { colors, icons } from '../theme.js';

interface InputBarProps {
    onSubmit: (value: string) => void;
}

export function InputBar({ onSubmit }: InputBarProps) {
    const [value, setValue] = useState('');
    const status = useTuiStore((s) => s.status);

    const isBusy = status === 'thinking' || status === 'executing';

    const handleSubmit = (input: string) => {
        const trimmed = input.trim();
        if (trimmed && !isBusy) {
            onSubmit(trimmed);
            setValue('');
        }
    };

    // Status indicator
    const getPrompt = () => {
        if (status === 'thinking') return `${icons.thinking} `;
        if (status === 'executing') return `${icons.bolt} `;
        return `${icons.snake} ${icons.prompt} `;
    };

    const promptColor = isBusy ? colors.silver : colors.emerald;

    return (
        <Box paddingX={0} marginTop={0}>
            {/* Themed Prompt */}
            <Text color={promptColor} bold>
                {getPrompt()}
            </Text>

            <TextInput
                value={value}
                onChange={setValue}
                onSubmit={handleSubmit}
                placeholder={isBusy ? "Processing..." : "Type a message..."}
            />
        </Box>
    );
}
