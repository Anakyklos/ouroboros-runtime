/**
 * 🐍 Ouroboros Theme Constants
 * 
 * Centralized design tokens for the TUI.
 * Reference: DESIGN.md
 */

// ============================================================================
// Color Palette (Snake-Inspired)
// ============================================================================

export const colors = {
    // Primary - Emerald (snake green)
    emerald: '#10B981',
    emeraldMuted: '#059669',
    emeraldDark: '#047857',

    // Accent - Gold (elegant, luxurious)
    gold: '#F59E0B',
    goldBright: '#FBBF24',

    // Backgrounds - Obsidian (dark, sophisticated)
    obsidian: '#0F172A',
    slate: '#1E293B',

    // Text
    pearl: '#F8FAFC',
    silver: '#94A3B8',

    // Status
    ruby: '#EF4444',
    amber: '#F59E0B',
} as const;

// ============================================================================
// Chalk Color Functions (for terminal)
// ============================================================================

import chalk from 'chalk';

export const theme = {
    // Text styles
    primary: chalk.hex(colors.emerald),
    secondary: chalk.hex(colors.emeraldMuted),
    accent: chalk.hex(colors.gold),
    accentBright: chalk.hex(colors.goldBright),
    text: chalk.hex(colors.pearl),
    muted: chalk.hex(colors.silver),
    error: chalk.hex(colors.ruby),

    // Combined styles
    user: chalk.hex(colors.gold).bold,
    agent: chalk.hex(colors.emerald),
    system: chalk.hex(colors.silver).italic,
    timestamp: chalk.hex(colors.silver).dim,

    // Status
    success: chalk.hex(colors.emerald).bold,
    warning: chalk.hex(colors.amber).bold,
    danger: chalk.hex(colors.ruby).bold,
} as const;

// ============================================================================
// Icons / Symbols
// ============================================================================

export const icons = {
    snake: '🐍',
    bolt: '⚡',
    thinking: '💭',
    error: '❌',
    success: '✓',
    info: 'ℹ',
    prompt: '›',
    bullet: '•',
} as const;

// ============================================================================
// Status Display
// ============================================================================

export const statusDisplay = {
    idle: `${icons.snake} Ready`,
    thinking: `${icons.thinking} Thinking...`,
    executing: `${icons.bolt} Executing...`,
    error: `${icons.error} Error`,
} as const;

// ============================================================================
// Message Formatting
// ============================================================================

export function formatUserMessage(content: string): string {
    return `${theme.accent(icons.bolt)} ${theme.user('You:')} ${theme.text(content)}`;
}

export function formatAgentMessage(content: string): string {
    return `${theme.primary(icons.snake)} ${theme.secondary('Ouroboros:')} ${theme.text(content)}`;
}

export function formatSystemMessage(content: string): string {
    return `${theme.muted(icons.info)} ${theme.system(content)}`;
}

export function formatTimestamp(date: Date): string {
    const time = date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
    return theme.timestamp(time);
}
