/**
 * Test Utilities
 */

// Simple regex to strip ANSI escape codes
// eslint-disable-next-line no-control-regex
const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function expect(value: unknown): {
    toBe: (expected: unknown) => void;
} {
    return {
        toBe(expected: unknown) {
            if (value !== expected) {
                throw new Error(`Expected ${expected}, got ${value}`);
            }
        }
    };
}

export function stripAnsi(str: string): string {
    return str.replace(ansiRegex, '');
}
