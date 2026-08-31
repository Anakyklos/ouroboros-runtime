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

import type { PlanStep } from "./contracts.js";

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
/** ------------------------------------------------------------------ */
/**  PlanStep structural sanitization (nested free-form fields)         */
/** ------------------------------------------------------------------ */

/**
 * Structurally sanitize EVERY free-form/nested text field of a PlanStep
 * before it is persisted. This is the explicit durable-boundary helper for
 * plan steps: it never relies on `...step` followed by partial sanitization.
 */
export function sanitizePlanStep(
    step: PlanStep,
): PlanStep {
    return {
        ...step,
        desiredOutcome: sanitizeText(step.desiredOutcome),
        expectedAcceptance: sanitizeStringArray(step.expectedAcceptance),
        approvalRequirement: step.approvalRequirement
            ? {
                  ...step.approvalRequirement,
                  reason: sanitizeText(step.approvalRequirement.reason),
                  approver: sanitizeText(step.approvalRequirement.approver),
              }
            : undefined,
        fallbacks: step.fallbacks?.map((fb) => ({
            ...fb,
            reason: sanitizeText(fb.reason),
        })),
    };
}

/** ------------------------------------------------------------------ */
/**  Fail-closed durable-boundary guarantee                             */
/** ------------------------------------------------------------------ */

/**
 * Detect a RAW secret pattern in a string, using the same detectors as the
 * sanitizer but WITHOUT matching already-redacted `[REDACTED]` tokens.
 * Used to reject (fail-closed) identifiers/refs/capability-ids that contain
 * a secret — silently redacting those would change identity/target.
 */
export function containsRawSecret(value: string): boolean {
    // Authorization: Bearer/Basic <token> (token not already redacted)
    if (/\bAuthorization\s*:\s*(Bearer|Basic)\s+(?!\[REDACTED\])\S+/i.test(value)) {
        return true;
    }
    // key=value / key:value for known secret keys (value not already redacted)
    if (
        /\b(api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|private[_-]?key|credentials?|token)\s*[=:]\s*(?!\[REDACTED\])\S+/i.test(
            value,
        )
    ) {
        return true;
    }
    // Standalone Bearer token (long-ish base64)
    if (/\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{6,}\b/i.test(value)) {
        return true;
    }
    return false;
}

/**
 * Recursively assert that no string in a value (object/array/string tree)
 * contains a raw secret pattern. Applied at the durable boundary before a
 * Mission, PlanRevision or Invocation is written: any field — including
 * identifiers, capability ids and references — that carries a known secret
 * pattern is rejected fail-closed instead of being silently redacted.
 */
export function assertNoRawSecrets(value: unknown, path = "value"): void {
    if (typeof value === "string") {
        if (containsRawSecret(value)) {
            throw new Error(
                `Raw secret detected in persisted field "${path}"; fail-closed before durable write (identifiers/refs are never silently redacted)`,
            );
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertNoRawSecrets(item, `${path}[${index}]`));
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            assertNoRawSecrets(item, `${path}.${key}`);
        }
    }
}
