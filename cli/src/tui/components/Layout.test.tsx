import React from 'react';
import { describe, it, expect } from 'bun:test';
import { render } from 'ink-testing-library';
import { Layout } from './Layout.js';
import { stripAnsi } from '../../test-utils.js';

describe('Layout', () => {
    it('renders all components', () => {
        const { lastFrame } = render(<Layout onSubmit={() => {}} />);
        const output = stripAnsi(lastFrame());

        // Check Header
        expect(output).toContain('Ouroboros v1.0');

        // Check StatusPanel
        // Default status is 'idle', so it should show IDLE
        expect(output).toContain('IDLE');

        // Check LogViewer area (might be empty initially)
        // But LogViewer renders logs from store. Default store has logs=[].
        // LogViewer with empty logs renders nothing visible inside or just empty box.
        // But we expect LogViewer component to be present.

        // Check InputBar
        expect(output).toContain('Type a message...');
    });
});
