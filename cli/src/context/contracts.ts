/**
 * 🧩 Context Compiler Contracts (Issue #64)
 *
 * First-class boundary that compiles a Bounded Context Package for a
 * Mission: minimal, authorized, budgeted content with EXPLICIT provenance.
 *
 * Ouroboros compiles and references context. It NEVER becomes a universal
 * memory bank and NEVER assumes ownership of any sovereign module's data
 * (Katherine, LifeOS, Tecer, Runstead, device modules). Ownership stays
 * with the module owner; the compiler only carries references/provenance.
 *
 * Flow:
 *   Mission
 *     → declarative context need (ContextRequest)
 *     → RegistryBoundContextReader (#63 boundary, #62 policy authorization)
 *     → Context Compiler (deterministic, offline)
 *     → Bounded Context Package (provenance + classification + budget)
 *     → planner / verifiers (CONSUMERS of data, never authority)
 *
 * Authority rule (structural, not prompt-level): external content is DATA.
 * Nothing compiled here can mutate originalIntent, constraints, acceptance,
 * approvals, or capability authorization — the compiler holds no such API.
 *
 * Provider-independent and persona-independent. No tokenizer, no network,
 * no model calls. Token-like estimates use a documented local heuristic.
 */

/** Version of the Context Compiler contract. Bump on breaking changes. */
export const CONTEXT_COMPILER_CONTRACT_VERSION = 1 as const;

/**
 * Sensitivity/redaction class of a compiled item. Metadata about how the
 * item may be disclosed — NOT a permission: authorization was already
 * decided before compilation (Mission scope + deterministic policy).
 */
export enum SensitivityClass {
    /** Included as-is. */
    NORMAL = "normal",
    /** Secret-like patterns were redacted before compilation. */
    REDACTED = "redacted",
    /** Owner-declared restricted content: reference-only, no content. */
    RESTRICTED = "restricted",
}

/**
 * Epistemic classification. These classes are SEMANTICALLY DISTINCT and the
 * compiler never promotes between them:
 *  - fact            — observed/recorded state from an authorized source
 *                      (mission-owned ref or authorized capability read).
 *  - derived_summary — bounded summary PRODUCED BY THE COMPILER from source
 *                      items; always traceable to the source item ids.
 *  - inference       — explicit, provenance-carrying guess submitted by the
 *                      requester side (e.g. planner). Never produced by the
 *                      compiler, never a fact, never promoted.
 */
export enum EpistemicClass {
    FACT = "fact",
    DERIVED_SUMMARY = "derived_summary",
    INFERENCE = "inference",
}

/**
 * Honest status of a requested source. A source that could not be read
 * never becomes a silent empty success — it is carried as a typed record.
 * One owner's failure never destroys items compiled from other owners.
 */
export enum SourceStatus {
    INCLUDED = "included",
    /** Capability exists but is not currently available. */
    UNAVAILABLE = "unavailable",
    /** Deterministic policy denied the read (not authorized / revoked). */
    REVOKED = "revoked",
    /** Content older than the request's freshness requirement. */
    STALE = "stale",
    /** Descriptor/connector/row shape is not declaratively compatible. */
    UNSUPPORTED = "unsupported",
    /** Capability needs configuration (honest degradation, not silence). */
    CONFIGURATION_ERROR = "configuration_error",
}

/** Explicit, deterministic budgets for a compiled package. */
export interface ContextBudget {
    /** Maximum number of items in the package. */
    maxItems: number;
    /** Maximum total serialized size of item content, in UTF-16 code units. */
    maxTotalChars: number;
    /** Maximum token-like estimate (see estimateTokens; no tokenizer dep). */
    maxEstimatedTokens: number;
}

/**
 * Declarative need for context. Describes WHAT is needed — never HOW to
 * access storage. A planner may PROPOSE external reads via ownerHint; it
 * cannot choose databases, SQL, private filesystems or bypass policy.
 * Resolution happens only through the deterministic layer (#62 policy +
 * #63 registry, inside the RegistryBoundContextReader).
 */
export interface ContextRequest {
    /** Subject of the requested context (declarative; also the read ref). */
    subject: string;
    /** Why the Mission needs it (declarative). */
    purpose: string;
    /** Non-binding hint about the expected owner (e.g. "lifeos"). */
    ownerHint?: string;
    /** Mission that justifies the read (authorization anchor). */
    missionId: string;
    /** Step that justifies the read, when applicable. */
    stepId?: string;
    /** Explicit budgets for the resulting package. */
    budget: ContextBudget;
    /**
     * Freshness requirement in ms. When set, external rows older than this
     * (or without a valid timestamp) are recorded as STALE — never silently
     * passed as fresh facts.
     */
    maxAgeMs?: number;
    /**
     * Restrict compiled items to these epistemic classes (minimal
     * disclosure). Absent = no restriction beyond the budgets.
     */
    requestedClasses?: EpistemicClass[];
}

/** Why an item was excluded — honest accounting, never silent. */
export type BudgetExclusionReason =
    | "duplicate"
    | "class_not_requested"
    | "scope_exceeded"
    | "secret_refused";

/** A recorded exclusion (item id + deterministic reason). */
export interface BudgetExclusion {
    itemId: string;
    reason: BudgetExclusionReason;
}

/** First-class provenance of a compiled item (always present). */
export interface ItemProvenance {
    /** Owner/source module (e.g. "lifeos") or the mission-owned owner. */
    owner: string;
    /** Opaque source reference INSIDE the owner boundary (never a DB path). */
    sourceRef: string;
    /** Capability contract version, when served through the #63 boundary. */
    sourceVersion?: number;
    /** Deterministic timestamp: row's own fetch time or compilation time. */
    fetchedAt: string;
    /** What authorized this use (sanitized, deterministic description). */
    authorization: string;
    /** Mission that justified the read. */
    missionId: string;
    /** Declared purpose/step, when applicable. */
    purpose?: string;
    /** Freshness/expiry, when the request declared maxAgeMs. */
    expiresAt?: string;
    /** Sensitivity/redaction class. */
    sensitivity: SensitivityClass;
    /** Mission-owned state vs external owner content. */
    origin: "mission_owned" | "external_owner";
    /** Evidence/reference identity, when the row backs or cites evidence. */
    evidenceRefId?: string;
}

/** A single compiled context item — inert data, never instructions. */
export interface ContextItem {
    /** Deterministic item id (hash of provenance identity + content). */
    itemId: string;
    /** Epistemic class (fact / derived_summary / inference). */
    epistemicClass: EpistemicClass;
    /** Sanitized content. DATA ONLY. */
    content: string;
    /** Provenance (first-class, always present). */
    provenance: ItemProvenance;
    /** For derived summaries: source item ids (reconstructible lineage). */
    derivedFrom?: string[];
    /** For derived summaries: deterministic operation note (e.g. "first:1"). */
    derivationOp?: string;
}

/** A source that could not be read — honest degradation record. */
export interface UnresolvedSource {
    /** Sanitized proposed reference (or the request subject). */
    requestedRef: string;
    /** Owner label when known (hint or descriptor owner). */
    owner: string;
    /** Typed honest status. */
    status: SourceStatus;
    /** Sanitized detail (no secrets, no private paths). */
    detail: string;
}

/** The compiled, versioned, bounded context package. Inert data: plain
 * JSON, no functions, no code, no authority. Consumers receive this as
 * data — structurally unable to mutate Mission intent/constraints/etc. */
export interface BoundedContextPackage {
    /** Deterministic package id (hash of the full package content). */
    packageId: string;
    /** Contract version of this package shape. */
    contractVersion: typeof CONTEXT_COMPILER_CONTRACT_VERSION;
    /** Mission the package was compiled for. */
    missionId: string;
    /** Step, when the request was step-scoped. */
    stepId?: string;
    /** Deterministic compilation timestamp. */
    compiledAt: string;
    /** The request that produced this package. */
    request: ContextRequest;
    /** Compiled items (bounded, deduplicated, classified). */
    items: ContextItem[];
    /** Honest degradation records for unreadable sources. */
    unresolved: UnresolvedSource[];
    /** Budget accounting (deterministic, with recorded exclusions). */
    budgetReport: {
        limits: {
            maxItems: number;
            maxTotalChars: number;
            maxEstimatedTokens: number;
        };
        observed: {
            items: number;
            totalChars: number;
            estimatedTokens: number;
        };
        /** Recorded exclusions (duplicates, class filter, caps, secrets). */
        excluded: BudgetExclusion[];
    };
}

/**
 * Deterministic, LOCAL size estimate. Documented semantics: 1 estimated
 * token ≈ 4 chars. No tokenizer dependency, no network, no model call.
 */
export const CHARS_PER_ESTIMATED_TOKEN = 4 as const;

export function estimateTokens(chars: number): number {
    return Math.ceil(chars / CHARS_PER_ESTIMATED_TOKEN);
}

/** A row an owner-side context adapter may return (opaque, sanitized). */
export interface ContextRow {
    /** Opaque source reference inside the owner boundary. */
    sourceRef: string;
    /** Raw row content (sanitized + classified by the compiler). */
    content: string;
    /** Source-carried timestamp for freshness, when available. */
    fetchedAt?: string;
    /** Evidence/reference identity, when the row backs evidence. */
    evidenceRefId?: string;
    /** Owner-declared sensitivity, when declared. */
    sensitivity?: SensitivityClass;
}

/** Minimal structural view of a descriptor inside a pre-authorized read. */
export interface CompiledSourceReadDescriptor {
    capabilityId: string;
    moduleOwner: string;
    contractVersion: number;
}

/** A successful pre-authorized read served through the #63 boundary. */
export interface CompiledSourceRead {
    /** The authorized descriptor that gated and labels the rows. */
    descriptor: CompiledSourceReadDescriptor;
    rows: ContextRow[];
}
