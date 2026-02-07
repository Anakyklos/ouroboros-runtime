import React from 'react';
import { describe, it, expect } from 'bun:test';
import { render } from 'ink-testing-library';
import { LogViewer } from './LogViewer.js';
import { LogEntry } from '../types.js';

describe('LogViewer', () => {
    const mockLogs: LogEntry[] = [
        { id: '1', level: 'info', message: 'Log 1', timestamp: new Date('2023-01-01T10:00:00Z') },
        { id: '2', level: 'warn', message: 'Log 2', timestamp: new Date('2023-01-01T10:00:01Z') },
        { id: '3', level: 'error', message: 'Log 3', timestamp: new Date('2023-01-01T10:00:02Z') },
    ];

    it('renders logs correctly', () => {
        const { lastFrame } = render(<LogViewer logs={mockLogs} />);
        const output = lastFrame();
        expect(output).toContain('Log 1');
        expect(output).toContain('Log 2');
        expect(output).toContain('Log 3');
        expect(output).toContain('INFO');
        expect(output).toContain('WARN');
        expect(output).toContain('ERROR');
    });

    it('respects maxHeight and autoScroll', () => {
        const manyLogs: LogEntry[] = Array.from({ length: 20 }, (_, i) => ({
            id: `${i}`,
            level: 'info',
            message: `Log ${i}`,
            timestamp: new Date(),
        }));

        const { lastFrame } = render(<LogViewer logs={manyLogs} maxHeight={5} autoScroll={true} />);
        const output = lastFrame();

        // Should show last 5 logs
        expect(output).toContain('Log 15');
        expect(output).toContain('Log 19');
        expect(output).not.toContain('Log 0');
        expect(output).not.toContain('Log 14');
    });

    it('handles empty logs', () => {
        const { lastFrame } = render(<LogViewer logs={[]} />);
        const output = lastFrame();
        expect(output).toBe('');
    });
});
