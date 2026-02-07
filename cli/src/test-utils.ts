export function describe(name: string, fn: () => void): void {
    console.log(`Running: ${name}`);
    fn();
}

export function it(name: string, fn: () => void | Promise<void>): void {
    console.log(`  ${name}`);
    fn();
}

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
    return str.replace(
        /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
        ''
    );
}
