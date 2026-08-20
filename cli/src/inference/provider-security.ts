/**
 * 🔑 Provider credential references, durable isolation scopes, and invocation.
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { redactError, redactText } from "./redaction.js";
import type {
    ModelProvider,
    ModelRequest,
    ModelResponse,
    ProviderCallContext,
} from "./ModelProvider.js";
import type { EventBus } from "../daemon/event-bus.js";
import type { ProviderResilience } from "./provider-resilience.js";

const SCOPE_SALT_ENV = "OUROBOROS_CREDENTIAL_SCOPE_SALT";
const SCOPE_SALT_FILE = "credential-scope-salt";

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
 * Opções de construção do registry. Sem `salt`, a identidade é persistida em
 * `.ouroboros/credential-scope-salt` ou lida de `OUROBOROS_CREDENTIAL_SCOPE_SALT`.
 */
export interface CredentialRegistryOptions {
    projectRoot?: string;
    stateDir?: string;
    salt?: string;
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
 * Erro de isolamento: a referência foi apresentada com um escopo diferente do
 * escopo derivado pelo registry. Nunca há fallback para outro escopo.
 */
export class CredentialScopeMismatchError extends Error {
    readonly credentialRef: string;

    constructor(credentialRef: string) {
        super(`Credential scope mismatch for reference ${redactText(credentialRef)}`);
        this.name = "CredentialScopeMismatchError";
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

function readPersistedSalt(filePath: string): string | undefined {
    try {
        const value = fs.readFileSync(filePath, "utf8").trim();
        if (!value) {
            throw new Error(`Credential scope salt file is empty: ${filePath}`);
        }
        return value;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

/**
 * Lê ou cria uma identidade local estável para os scopes de credencial.
 * A criação é atômica para que dois processos concorrentes compartilhem o
 * mesmo salt em vez de derivarem namespaces incompatíveis.
 */
export function loadOrCreateCredentialScopeSalt(
    projectRoot = process.cwd(),
    stateDir = ".ouroboros",
): string {
    const configuredSalt = process.env[SCOPE_SALT_ENV]?.trim();
    if (configuredSalt) return configuredSalt;

    const directory = path.resolve(projectRoot, stateDir);
    const filePath = path.join(directory, SCOPE_SALT_FILE);
    const persisted = readPersistedSalt(filePath);
    if (persisted) return persisted;

    fs.mkdirSync(directory, { recursive: true });
    const generated = randomBytes(32).toString("hex");
    try {
        fs.writeFileSync(filePath, `${generated}\n`, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
        });
        return generated;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const concurrent = readPersistedSalt(filePath);
        if (!concurrent) throw new Error(`Credential scope salt was not created: ${filePath}`);
        return concurrent;
    }
}

/**
 * Registry de credenciais mantido apenas em memória do processo.
 */
export class CredentialRegistry {
    #credentials = new Map<string, string>();
    #salt: string;

    constructor(saltOrOptions: string | CredentialRegistryOptions = {}) {
        if (typeof saltOrOptions === "string") {
            this.#salt = saltOrOptions;
        } else if (saltOrOptions.salt?.trim()) {
            this.#salt = saltOrOptions.salt.trim();
        } else {
            this.#salt = loadOrCreateCredentialScopeSalt(
                saltOrOptions.projectRoot ?? process.cwd(),
                saltOrOptions.stateDir ?? ".ouroboros",
            );
        }
        if (!this.#salt) throw new Error("Credential registry scope salt must not be empty");
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

    /** Deriva o scope esperado sem resolver ou expor o segredo. */
    resolveScope(credentialRef: string): string {
        return createCredentialScope(credentialRef, this.#salt);
    }

    /** Resolve o segredo no momento da chamada e mantém o campo secreto fora da serialização JSON. */
    resolve(credentialRef: string): ResolvedCredential {
        const secret = this.#credentials.get(credentialRef);
        if (!secret) throw new CredentialUnavailableError(credentialRef);

        const resolved = {
            credentialRef,
            credentialScope: this.resolveScope(credentialRef),
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

export interface CredentialedProviderTransport {
    /**
     * Transport boundary that receives the secret only for the duration of a
     * single authorized call. It must never persist or log the argument.
     */
    complete(
        provider: ModelProvider,
        request: ModelRequest,
        context: ProviderCallContext,
        secret: string,
    ): Promise<ModelResponse>;
}

export interface CredentialSelection {
    credentialRef: string;
    credentialScope: string;
}

const defaultTransport: CredentialedProviderTransport = {
    complete: (provider, request, context) => provider.complete(request, context),
};

/**
 * Camada superior que resolve, usa e revoga uma credencial ao redor de uma
 * chamada real. O ModelProvider continua sem acesso ao secret store.
 */
export class CredentialedProviderInvoker {
    constructor(
        private readonly provider: ModelProvider,
        private readonly registry: CredentialRegistry,
        private readonly eventBus: EventBus,
        private readonly transport: CredentialedProviderTransport = defaultTransport,
        private readonly resilience?: ProviderResilience,
    ) {}

    async complete(
        request: ModelRequest,
        selection: CredentialSelection,
        context: ProviderCallContext,
    ): Promise<ModelResponse> {
        if (
            context.credentialRef !== selection.credentialRef
            || context.credentialScope !== selection.credentialScope
        ) {
            throw new CredentialScopeMismatchError(selection.credentialRef);
        }

        const resolved = this.registry.resolve(selection.credentialRef);
        if (resolved.credentialScope !== selection.credentialScope) {
            throw new CredentialScopeMismatchError(selection.credentialRef);
        }

        this.eventBus.registerRedactionSecret(resolved.secret);
        try {
            const callTransport = () => this.transport.complete(
                this.provider,
                request,
                {
                    ...context,
                    credentialRef: resolved.credentialRef,
                    credentialScope: resolved.credentialScope,
                },
                resolved.secret,
            );
            return await (this.resilience
                ? this.resilience.execute(
                    { providerId: this.provider.providerId, credentialScope: resolved.credentialScope },
                    context.signal,
                    callTransport,
                )
                : callTransport());
        } catch (error) {
            throw redactError(error, [resolved.secret]);
        } finally {
            this.eventBus.revokeRedactionSecret(resolved.secret);
        }
    }
}
