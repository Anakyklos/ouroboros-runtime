/**
 * 🛡️ Secret Sanitization (Issue #62)
 *
 * Deterministic boundary for redacting known secret patterns from free-form
 * text before it is persisted. This is NOT a universal detector — it covers
 * the patterns explicitly prohibited by #62 (Authorization, Bearer tokens,
 * api_key, credentials, tokens).
 *
 * Applied to: MissionIntent.originalIntent, constraints, acceptanceCriteria,
 * explicitChoices, plannerNote, PlanStep.desiredOutcome/expectedAcceptance,
 * and any other free-form text that receives external data.
 */

// Pattern → replacement function. The replacement preserves the key name
// and replaces the value with [REDACTED] so the structure is still readable.
const REDACTORS: Array<{ pattern: RegExp; replace: (match: string) => string }> = [
    {
        // Authorization: Bearer <token> or Authorization: Basic <credential>
        pattern: /\b(Authorization\s*:\s*)(Bearer|Basic)\s+\S+\s*/gi,
        replace: (m) => {
            const idx = m.indexOf(":");
            if (idx === -1) return "[REDACTED]";
            const scheme = m.includes("Basic") ? "Basic" : "Bearer";
            return `${m.slice(0, idx + 1).trim()} ${scheme} [REDACTED] `;
        },
    },
    {
        // Standalone Bearer token (long-ish base64)
        pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}\b/g,
        replace: () => "Bearer [REDACTED]",
    },
    {
        // password=... / password:...
        pattern: /\b(password\s*[=:]\s*)\S+/gi,
        replace: (m) => {
            const idx = m.search(/[=:]/);
            if (idx === -1) return "[REDACTED]";
            return `${m.slice(0, idx + 1).trim()} [REDACTED]`;
        },
    },
    {
        // private_key=... / privateKey=...
        pattern: /\b(private[_-]?key\s*[=:]\s*)\S+/gi,
        replace: (m) => {
            const idx = m.search(/[=:]/);
            if (idx === -1) return "[REDACTED]";
            return `${m.slice(0, idx + 1).trim()} [REDACTED]`;
        },
    },
    {
        // api_key=... / apiKey=...
        pattern: /\b(api[_-]?key\s*[=:]\s*)\S+/gi,
        replace: (m) => {
            const idx = m.search(/[=:]/);
            if (idx === -1) return "[REDACTED]";
            return `${m.slice(0, idx + 1).trim()} [REDACTED]`;
        },
    },
    {
        // api_secret=... / apiSecret=...
        pattern: /\b(api[_-]?secret\s*[=:]\s*)\S+/gi,
        replace: (m) => {
            const idx = m.search(/[=:]/);
            if (idx === -1) return "[REDACTED]";
            return `${m.slice(0, idx + 1).trim()} [REDACTED]`;
        },
    },
    {
        // client_secret=... / clientSecret=...
        pattern: /\b(client[_-]?secret\s*[=:]\s*)\S+/gi,
        replace: (m) => {
            const idx = m.search(/[=:]/);
            if (idx === -1) return "[REDACTED]";
            return `${m.slice(0, idx + 1).trim()} [REDACTED]`;
        },
    },
    {
        // access_token=... / accessToken=...
        pattern: /\b(access[_-]?token\s*[=:]\s*)\S+/gi,
        replace: (m) => {
            const idx = m.search(/[=:]/);
            if (idx === -1) return "[REDACTED]";
            return `${m.slice(0, idx + 1).trim()} [REDACTED]`;
        },
    },
    {
        // refresh_token=... / refreshToken=...
        pattern: /\b(refresh[_-]?token\s*[=:]\s*)\S+/gi,
        replace: (m) => {
            const idx = m.search(/[=:]/);
            if (idx === -1) return "[REDACTED]";
            return `${m.slice(0, idx + 1).trim()} [REDACTED]`;
        },
    },
    {
        // credentials=... / credentials:...
        pattern: /\b(credentials?\s*[=:]\s*)\S+/gi,
        replace: (m) => {
            const idx = m.search(/[=:]/);
            if (idx === -1) return "[REDACTED]";
            return `${m.slice(0, idx + 1).trim()} [REDACTED]`;
        },
    },
    {
        // token=... / token:... (generic)
        pattern: /\b(token\s*[=:]\s*)\S+/gi,
        replace: (m) => {
            const idx = m.search(/[=:]/);
            if (idx === -1) return "[REDACTED]";
            return `${m.slice(0, idx + 1).trim()} [REDACTED]`;
        },
    },
];

/**
 * Sanitize a free-form text string by redacting known secret patterns.
 * The redacted form is safe for persistence.
 */
export function sanitizeText(text: string): string {
    let out = text;
    for (const { pattern, replace } of REDACTORS) {
        out = out.replace(pattern, replace);
    }
    return out;
}

/**
 * Sanitize all string entries in an array.
 */
export function sanitizeStringArray(arr: string[]): string[] {
    return arr.map((s) => sanitizeText(s));
}