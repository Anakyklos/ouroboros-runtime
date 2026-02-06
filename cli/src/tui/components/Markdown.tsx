import React from 'react';
import { Box, Text } from 'ink';
import { marked } from 'marked';

interface MarkdownProps {
    children: string;
}

interface TokenProps {
    token: any;
    key?: number | string;
}

export function Markdown({ children }: MarkdownProps) {
    const tokens = marked.lexer(children);

    return (
        <Box flexDirection="column">
            {tokens.map((token, index) => (
                <MarkdownToken key={index} token={token} />
            ))}
        </Box>
    );
}

function MarkdownToken({ token }: TokenProps) {
    switch (token.type) {
        case 'paragraph':
            return (
                <Box marginBottom={1}>
                    <Text>
                        {token.tokens ? token.tokens.map((t: any, i: number) => (
                            <InlineToken key={i} token={t} />
                        )) : token.text}
                    </Text>
                </Box>
            );

        case 'heading':
            return (
                <Box marginTop={1} marginBottom={1}>
                    <Text bold color="blue">
                        {'#'.repeat(token.depth)} {token.text}
                    </Text>
                </Box>
            );

        case 'code':
            return (
                <Box
                    flexDirection="column"
                    paddingX={1}
                    paddingY={0}
                    borderStyle="single"
                    borderColor="gray"
                    marginBottom={1}
                >
                    {token.lang && (
                        <Text color="gray" dimColor>{token.lang}</Text>
                    )}
                    <Text color="yellow">{token.text}</Text>
                </Box>
            );

        case 'list':
            return (
                <Box flexDirection="column" marginBottom={1}>
                    {token.items.map((item: any, i: number) => (
                        <Box key={i} marginLeft={2}>
                            <Text>• </Text>
                            <Text>
                                {item.tokens ? item.tokens.map((t: any, j: number) => (
                                     <InlineToken key={j} token={t} />
                                )) : item.text}
                            </Text>
                        </Box>
                    ))}
                </Box>
            );

        case 'space':
            return null;

        default:
            return <Text>{token.raw}</Text>;
    }
}

function InlineToken({ token }: TokenProps) {
    switch (token.type) {
        case 'strong':
            return <Text bold>{token.text}</Text>;
        case 'em':
            return <Text italic>{token.text}</Text>;
        case 'codespan':
            return <Text color="yellow" backgroundColor="black"> {token.text} </Text>;
        case 'text':
        case 'escape':
            return <Text>{token.text}</Text>;
        default:
            return <Text>{token.raw}</Text>;
    }
}
