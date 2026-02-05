import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useTuiStore } from '../store.js';

interface InputBarProps {
    onSubmit: (value: string) => void;
}

export function InputBar({ onSubmit }: InputBarProps): React.ReactElement {
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

    return (
        <Box paddingX={0} marginTop={0}>
            {/* Minimalist Prompt */}
            <Text color={isBusy ? "gray" : "cyan"} bold>
                {isBusy ? "⟳ " : "› "}
            </Text>

            <TextInput
                value={value}
                onChange={setValue}
                onSubmit={handleSubmit}
                placeholder={isBusy ? "Wait..." : "Type a message..."}
            />
        </Box>
    );
}
