import React from 'react';
import { describe, it, expect } from 'bun:test';
import { render } from 'ink-testing-library';
import { StatusPanel } from './StatusPanel.js';
import { TuiMetrics } from '../types.js';

describe('StatusPanel', () => {
    const mockMetrics: TuiMetrics = { tokens: 1000, cost: 0.05, uptime: 100 };

    it('renders idle status correctly', () => {
        const { lastFrame } = render(<StatusPanel status="idle" metrics={mockMetrics} />);
        const output = lastFrame();
        expect(output).toContain('IDLE');
        expect(output).toContain('Tokens: 1,000');
        expect(output).toContain('Cost: $0.0500');
    });

    it('renders thinking status correctly', () => {
        const { lastFrame } = render(<StatusPanel status="thinking" metrics={mockMetrics} />);
        const output = lastFrame();
        expect(output).toContain('THINKING');
    });

    it('renders dispatching status correctly', () => {
        const { lastFrame } = render(<StatusPanel status="dispatching" metrics={mockMetrics} />);
        const output = lastFrame();
        expect(output).toContain('DISPATCHING');
    });

    it('renders current task if provided', () => {
        const { lastFrame } = render(<StatusPanel status="idle" metrics={mockMetrics} currentTask="Analyzing data" />);
        const output = lastFrame();
        expect(output).toContain('Task: Analyzing data');
    });

    it('does not render task if not provided', () => {
        const { lastFrame } = render(<StatusPanel status="idle" metrics={mockMetrics} />);
        const output = lastFrame();
        expect(output).not.toContain('Task:');
    });
});
