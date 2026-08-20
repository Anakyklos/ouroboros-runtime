/**
 * 🔑 In-memory provider credential references and isolation scopes.
 */

import { createHash, randomBytes } from "node:crypto";
import { redactText } from "./redaction.js";

const DEFAULT_SCOPE_SALT = process.env.OUROBOROS_CREDENTIAL_SCOPE_SALT ?? randomBytes(32).toString("hex");

/**
 * Flags declaradas por um provider/modelo sem conter autorização ou segredo.
 */
export interface ProviderFeatureFlags {
    streaming: boolean;
    tools: boolean;
    structuredOutput: boolean;
}

/**
 * Configuração persistível de um par provider/modelo.
 */
export interface ProviderModelConfig {
    providerId: string;
    modelId: string;
    endpoint: string;
    timeoutMs: number;
    featureFlags: ProviderFeatureFlags;
    credentialRef?: string;
    quotaProfile?: string;
}

/**
 * Credencial resolvida somente durante uma chamada. O segredo é não enumerável.
 */
export interface ResolvedCredential {
    readonly credentialRef: string;
    readonly credentialScope: string;
    readonly secret: string;
}

/**
 * Erro genérico para ausência ou invalidade de credencial sem refletir o segredo.
 */
export class CredentialUnavailableError extends Error {
    readonly credentialRef: string;

    constructor(credentialRef: string) {
        super(`Credential unavailable for reference ${redactText(credentialRef)}`);
        this.name = "CredentialUnavailableError";
        this.credentialRef = credentialRef;
    }
}

/**
 * Gera uma fronteira opaca, não reversível, para uma referência de credencial.
 */
export function createCredentialScope(credentialRef: string, salt: string): string {
    const digest = createHash("sha256")
        .update(`${salt}\0${credentialRef}`, "utf8")
        .digest("hex");
    return `credential-scope-${digest}`;
}

/**
 * Registry de credenciais mantido apenas em memória do processo.
 */
export class CredentialRegistry {
    #credentials = new Map<string, string>();
    #salt: string;

    constructor(salt: string = DEFAULT_SCOPE_SALT) {
        if (!salt) throw new Error("Credential registry scope salt must not be empty");
        this.#salt = salt;
    }

    /** Registra ou substitui uma credencial sem devolver o valor em nenhum objeto persistível. */
    register(credentialRef: string, secret: string): void {
        if (!credentialRef || !secret) throw new CredentialUnavailableError(credentialRef);
        this.#credentials.set(credentialRef, secret);
    }

    /** Revoga somente a referência indicada, sem alterar outros escopos. */
    revoke(credentialRef: string): void {
        this.#credentials.delete(credentialRef);
    }

    /** Verifica se uma referência está registrada, sem resolver o segredo. */
    has(credentialRef: string): boolean {
        return this.#credentials.has(credentialRef);
    }

    /** Resolve o segredo no momento da chamada e mantém o campo secreto fora da serialização JSON. */
    resolve(credentialRef: string): ResolvedCredential {
        const secret = this.#credentials.get(credentialRef);
        if (!secret) throw new CredentialUnavailableError(credentialRef);

        const resolved = {
            credentialRef,
            credentialScope: createCredentialScope(credentialRef, this.#salt),
        } as ResolvedCredential;
        Object.defineProperty(resolved, "secret", {
            configurable: false,
            enumerable: false,
            value: secret,
            writable: false,
        });
        return Object.freeze(resolved);
    }

    /** Representação segura para logs, eventos e estado serializado. */
    toJSON(): Record<string, unknown> {
        return {
            credentialRefs: [...this.#credentials.keys()],
        };
    }
}
