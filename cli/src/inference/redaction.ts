/**
 * 🔒 Shared redaction for provider-facing logs, events, errors, and traces.
 */

export const REDACTED_VALUE = "[REDACTED]";

const SENSITIVE_KEY_PATTERN = /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|private[-_]?key|password|secret|token)/i;
const AUTHORIZATION_HEADER_PATTERN = /((?:authorization|proxy-authorization)\s*:\s*)[^\s,;]+(?:\s+[^\s,;]+)?/gi;
const BEARER_TOKEN_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi;
const BASIC_OR_TOKEN_PATTERN = /\b((?:Basic|Token)\s+)[A-Za-z0-9._~+/=-]{6,}/gi;
const SENSITIVE_QUERY_PATTERN = /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|key)=)[^&#\s]*/gi;
const SENSITIVE_ASSIGNMENT_PATTERN = /\b((?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret|password|token)\s*[:=]\s*["']?)[^"'&\s,;]+/gi;
const COMMON_PROVIDER_SECRET_PATTERN = /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{15,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{16,})\b/g;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redige headers, tokens, query parameters, common provider keys, and known secrets.
 */
export function redactText(value: string, knownSecrets: readonly string[] = []): string {
    let redacted = value;

    const usableSecrets = [...knownSecrets]
        .filter(secret => secret.length > 0)
        .sort((left, right) => right.length - left.length);
    for (const secret of usableSecrets) {
        redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED_VALUE);
    }

    redacted = redacted
        .replace(AUTHORIZATION_HEADER_PATTERN, `$1${REDACTED_VALUE}`)
        .replace(BEARER_TOKEN_PATTERN, `$1${REDACTED_VALUE}`)
        .replace(BASIC_OR_TOKEN_PATTERN, `$1${REDACTED_VALUE}`)
        .replace(SENSITIVE_QUERY_PATTERN, `$1${REDACTED_VALUE}`)
        .replace(SENSITIVE_ASSIGNMENT_PATTERN, `$1${REDACTED_VALUE}`)
        .replace(COMMON_PROVIDER_SECRET_PATTERN, REDACTED_VALUE);

    return redacted;
}

/**
 * Redige recursivamente valores estruturados sem alterar datas ou primitivos seguros.
 */
export function redactValue(value: unknown, knownSecrets: readonly string[] = []): unknown {
    if (typeof value === "string") return redactText(value, knownSecrets);
    if (value instanceof Date) return value;
    if (value instanceof Error) {
        const serialized: Record<string, unknown> = {
            name: value.name,
            message: redactText(value.message, knownSecrets),
        };
        if ("cause" in value) {
            serialized.cause = redactValue(value.cause, knownSecrets);
        }
        return serialized;
    }
    if (Array.isArray(value)) {
        return value.map(item => redactValue(item, knownSecrets));
    }
    if (value && typeof value === "object") {
        const redacted: Record<string, unknown> = {};
        for (const [key, nestedValue] of Object.entries(value)) {
            redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
                ? REDACTED_VALUE
                : redactValue(nestedValue, knownSecrets);
        }
        return redacted;
    }
    return value;
}
