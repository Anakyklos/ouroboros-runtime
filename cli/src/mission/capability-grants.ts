/**
 * Internal Capability Grant ledger primitives.
 *
 * This module persists and evaluates inert facts only. No production policy,
 * planning, acceptance, dispatch, or RPC path calls these functions.
 */

import { createHash } from "node:crypto";
import {
    EffectClass,
    type CapabilityContract,
    type MissionCapabilityGrant,
    type MissionCapabilityGrantInput,
    type MissionCapabilityRevocation,
    type MissionCapabilityRevocationInput,
} from "./contracts.js";
import { assertNoRawSecrets } from "./sanitize.js";

export type ReducedCapabilityGrantState = "active" | "expired" | "revoked" | "invalid";

export interface ReducedCapabilityGrant {
    missionId: string;
    grantId: string;
    state: ReducedCapabilityGrantState;
}

export interface ReduceCapabilityGrantLedgerInput {
    grants: readonly MissionCapabilityGrant[];
    revocations: readonly MissionCapabilityRevocation[];
    evaluatedAt: string;
    /** Future trusted-source evidence; absent revocation evidence fails closed. */
    authorityValidatedRevocationKeys?: ReadonlySet<string>;
}

export interface CapabilityGrantCoverageInput extends ReduceCapabilityGrantLedgerInput {
    missionId: string;
    capabilityId: string;
    effectClass: EffectClass;
    inputRefs: readonly string[];
    capabilityContract: CapabilityContract | null;
    /**
     * Keys proven by an authorized future issuer source. Missing keys fail
     * closed. Slice A does not provide such a source or activate this predicate.
     */
    authorityValidatedGrantKeys?: ReadonlySet<string>;
    /** No cross-grantor rule is defined here; a trusted source must validate revokers. */
    authorityValidatedRevocationKeys?: ReadonlySet<string>;
}

export interface CapabilityGrantCoverageDecision {
    valid: boolean;
    grantId?: string;
    reason: "covered" | "invalid_input" | "unknown_capability" | "not_covered" | "authority_unavailable";
}

interface ParsedReference {
    kind: "namespace" | "uri";
    scheme?: string;
    authority?: string;
    segments: string[];
}

function assertString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new Error(`Capability Grant ${field} must be a non-empty, trimmed string without controls`);
    }
    return value;
}

function assertInstant(value: unknown, field: string): string {
    const text = assertString(value, field);
    if (!isInstant(text)) {
        throw new Error(`Capability Grant ${field} must be a valid timestamp`);
    }
    return text;
}

function assertOrdinal(value: unknown, field: string): number | null {
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw new Error(`Capability Grant ${field} must be a positive ordinal when present`);
    }
    return value as number;
}

function assertEpochValue(value: unknown, field: string): number | null {
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`Capability Grant ${field} must be a non-negative integer when present`);
    }
    return value as number;
}

function decodePathSegment(segment: string): string | null {
    if (segment.length === 0) return null;
    let decoded = segment;
    for (let pass = 0; pass < 5; pass += 1) {
        if (/%(?![0-9a-f]{2})/iu.test(decoded)) return null;
        let next: string;
        try {
            next = decodeURIComponent(decoded);
        } catch {
            return null;
        }
        if (next === decoded) break;
        decoded = next;
        if (pass === 4 && /%[0-9a-f]{2}/iu.test(decoded)) return null;
    }
    if (
        decoded === "."
        || decoded === ".."
        || decoded.includes("/")
        || decoded.includes("\\")
        || /[\u0000-\u001f\u007f]/u.test(decoded)
    ) return null;
    return decoded;
}

function parseReference(value: string, isPrefix: boolean): ParsedReference | null {
    if (
        value.length === 0
        || value !== value.trim()
        || /[\u0000-\u0020\u007f\\?#]/u.test(value)
    ) return null;

    let kind: ParsedReference["kind"];
    let scheme: string | undefined;
    let authority: string | undefined;
    let path: string;
    const uriMarker = value.indexOf("://");
    if (uriMarker >= 0) {
        const rawScheme = value.slice(0, uriMarker);
        const rest = value.slice(uriMarker + 3);
        if (!/^[a-z][a-z0-9+.-]*$/iu.test(rawScheme) || rawScheme.toLowerCase() === "refs") return null;
        const slash = rest.indexOf("/");
        if (slash <= 0) return null;
        authority = rest.slice(0, slash);
        if (!/^[a-z0-9._~-]+(?::[0-9]{1,5})?$/iu.test(authority) || authority.includes("@")) return null;
        scheme = rawScheme.toLowerCase();
        path = rest.slice(slash + 1);
        kind = "uri";
    } else {
        if (value.includes(":")) return null;
        path = value;
        kind = "namespace";
    }

    if (isPrefix && path.endsWith("/")) path = path.slice(0, -1);
    if (path.length === 0) return null;
    const rawSegments = path.split("/");
    const segments = rawSegments.map(decodePathSegment);
    if (segments.some((segment) => segment === null)) return null;
    const decoded = segments as string[];
    if (kind === "namespace" && (decoded[0] !== "refs" || decoded.length < 2)) return null;
    return { kind, scheme, authority: authority?.toLowerCase(), segments: decoded };
}

/**
 * Match one resource reference to one prefix with category and segment
 * boundaries. This supports namespaced `refs/*` and URI refs without resolving
 * physical paths, aliases, or symlinks owned by a capability connector.
 */
export function capabilityGrantReferenceMatchesPrefix(reference: string, prefix: string): boolean {
    const parsedReference = parseReference(reference, false);
    const parsedPrefix = parseReference(prefix, true);
    if (!parsedReference || !parsedPrefix || parsedReference.kind !== parsedPrefix.kind) return false;
    if (
        parsedReference.kind === "uri"
        && (parsedReference.scheme !== parsedPrefix.scheme || parsedReference.authority !== parsedPrefix.authority)
    ) return false;
    return parsedPrefix.segments.length <= parsedReference.segments.length
        && parsedPrefix.segments.every((segment, index) => parsedReference.segments[index] === segment);
}

function normalizedGrant(input: MissionCapabilityGrantInput | MissionCapabilityGrant): Omit<MissionCapabilityGrant, "fingerprint"> {
    const value = input as MissionCapabilityGrantInput & Partial<Pick<MissionCapabilityGrant, "fingerprint">>;
    const grantId = assertString(value.grantId, "grantId");
    const missionId = assertString(value.missionId, "missionId");
    const capabilityId = assertString(value.capabilityId, "capabilityId");
    const grantorClientId = assertString(value.grantorClientId, "grantorClientId");
    const issuedAt = assertInstant(value.issuedAt, "issuedAt");
    const createdAt = assertInstant(value.createdAt, "createdAt");
    const expiresAt = value.expiresAt === undefined || value.expiresAt === null
        ? null
        : assertInstant(value.expiresAt, "expiresAt");
    const allowedEffectClasses = value.allowedEffectClasses;
    if (
        !Array.isArray(allowedEffectClasses)
        || allowedEffectClasses.length === 0
        || allowedEffectClasses.some((effect) => !Object.values(EffectClass).includes(effect))
        || new Set(allowedEffectClasses).size !== allowedEffectClasses.length
    ) throw new Error("Capability Grant allowedEffectClasses must contain unique known effects");
    const allowedRefPrefixes = value.allowedRefPrefixes;
    if (
        !Array.isArray(allowedRefPrefixes)
        || allowedRefPrefixes.some((prefix) => typeof prefix !== "string" || !parseReference(prefix, true))
        || new Set(allowedRefPrefixes).size !== allowedRefPrefixes.length
    ) throw new Error("Capability Grant allowedRefPrefixes must contain unique valid references");
    const grantorCredentialGeneration = assertOrdinal(value.grantorCredentialGeneration, "grantorCredentialGeneration");
    const grantorAuthorityEpoch = assertEpochValue(value.grantorAuthorityEpoch, "grantorAuthorityEpoch");
    const normalized = {
        grantId,
        missionId,
        capabilityId,
        allowedEffectClasses: [...allowedEffectClasses],
        allowedRefPrefixes: [...allowedRefPrefixes],
        grantorClientId,
        grantorCredentialGeneration,
        grantorAuthorityEpoch,
        issuedAt,
        expiresAt,
        createdAt,
    };
    assertNoRawSecrets(normalized);
    return normalized;
}

function normalizedRevocation(
    input: MissionCapabilityRevocationInput | MissionCapabilityRevocation,
): Omit<MissionCapabilityRevocation, "fingerprint"> {
    const value = input as MissionCapabilityRevocationInput & Partial<Pick<MissionCapabilityRevocation, "fingerprint">>;
    const normalized = {
        revocationId: assertString(value.revocationId, "revocationId"),
        missionId: assertString(value.missionId, "missionId"),
        grantId: assertString(value.grantId, "grantId"),
        revokerClientId: assertString(value.revokerClientId, "revokerClientId"),
        revokerCredentialGeneration: assertOrdinal(value.revokerCredentialGeneration, "revokerCredentialGeneration"),
        revokerAuthorityEpoch: assertEpochValue(value.revokerAuthorityEpoch, "revokerAuthorityEpoch"),
        revokedAt: assertInstant(value.revokedAt, "revokedAt"),
        createdAt: assertInstant(value.createdAt, "createdAt"),
    };
    assertNoRawSecrets(normalized);
    return normalized;
}

function hashCanonical(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function grantCanonicalValue(grant: Omit<MissionCapabilityGrant, "fingerprint">): unknown {
    return {
        grantId: grant.grantId,
        missionId: grant.missionId,
        capabilityId: grant.capabilityId,
        allowedEffectClasses: [...grant.allowedEffectClasses].sort(),
        allowedRefPrefixes: [...grant.allowedRefPrefixes].sort(),
        grantorClientId: grant.grantorClientId,
        grantorCredentialGeneration: grant.grantorCredentialGeneration,
        grantorAuthorityEpoch: grant.grantorAuthorityEpoch,
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
        createdAt: grant.createdAt,
    };
}

function revocationCanonicalValue(revocation: Omit<MissionCapabilityRevocation, "fingerprint">): unknown {
    return {
        revocationId: revocation.revocationId,
        missionId: revocation.missionId,
        grantId: revocation.grantId,
        revokerClientId: revocation.revokerClientId,
        revokerCredentialGeneration: revocation.revokerCredentialGeneration,
        revokerAuthorityEpoch: revocation.revokerAuthorityEpoch,
        revokedAt: revocation.revokedAt,
        createdAt: revocation.createdAt,
    };
}

/** Compute the canonical SHA-256 fingerprint for a grant fact. */
export function computeCapabilityGrantFingerprint(
    input: MissionCapabilityGrantInput | MissionCapabilityGrant,
): string {
    return hashCanonical(grantCanonicalValue(normalizedGrant(input)));
}

/** Compute the canonical SHA-256 fingerprint for a revocation fact. */
export function computeCapabilityRevocationFingerprint(
    input: MissionCapabilityRevocationInput | MissionCapabilityRevocation,
): string {
    return hashCanonical(revocationCanonicalValue(normalizedRevocation(input)));
}

/** Validate and canonicalize a grant before the durable write. */
export function normalizeCapabilityGrant(input: MissionCapabilityGrantInput): MissionCapabilityGrant {
    const normalized = normalizedGrant(input);
    return { ...normalized, fingerprint: hashCanonical(grantCanonicalValue(normalized)) };
}

/** Validate and canonicalize a revocation before the durable write. */
export function normalizeCapabilityRevocation(
    input: MissionCapabilityRevocationInput,
): MissionCapabilityRevocation {
    const normalized = normalizedRevocation(input);
    return { ...normalized, fingerprint: hashCanonical(revocationCanonicalValue(normalized)) };
}

function hasValidGrantFingerprint(grant: MissionCapabilityGrant): boolean {
    try {
        return typeof grant.fingerprint === "string"
            && /^[a-f0-9]{64}$/u.test(grant.fingerprint)
            && computeCapabilityGrantFingerprint(grant) === grant.fingerprint;
    } catch {
        return false;
    }
}

function hasValidRevocationFingerprint(revocation: MissionCapabilityRevocation): boolean {
    try {
        return typeof revocation.fingerprint === "string"
            && /^[a-f0-9]{64}$/u.test(revocation.fingerprint)
            && computeCapabilityRevocationFingerprint(revocation) === revocation.fingerprint;
    } catch {
        return false;
    }
}

function hasValidatedRevocationAuthority(
    revocation: MissionCapabilityRevocation,
    authorityKeys: ReadonlySet<string> | undefined,
): boolean {
    return hasValidRevocationFingerprint(revocation)
        && typeof revocation.revokerClientId === "string"
        && revocation.revokerClientId.length > 0
        && Number.isSafeInteger(revocation.revokerCredentialGeneration)
        && (revocation.revokerCredentialGeneration as number) >= 1
        && authorityKeys?.has(capabilityRevocationAuthorityKey(revocation.missionId, revocation.revocationId)) === true;
}

/** Stable, unambiguous key for external authority evidence. */
export function capabilityGrantAuthorityKey(missionId: string, grantId: string): string {
    return JSON.stringify([missionId, grantId]);
}

/** Stable, unambiguous key for external revocation-authority evidence. */
export function capabilityRevocationAuthorityKey(missionId: string, revocationId: string): string {
    return JSON.stringify([missionId, revocationId]);
}

/** Reduce immutable grant and revocation facts at an explicitly supplied time. */
export function reduceCapabilityGrantLedger(input: ReduceCapabilityGrantLedgerInput): ReducedCapabilityGrant[] {
    const sortStates = (states: ReducedCapabilityGrant[]): ReducedCapabilityGrant[] => states.sort((a, b) =>
        compareStable(a.missionId, b.missionId) || compareStable(a.grantId, b.grantId),
    );
    const inputGrants = Array.isArray(input.grants) ? input.grants : [];
    const inputRevocations = Array.isArray(input.revocations) ? input.revocations : [];
    if (!isInstant(input.evaluatedAt)) {
        return sortStates(inputGrants.map((grant) => ({
            missionId: typeof grant?.missionId === "string" ? grant.missionId : "",
            grantId: typeof grant?.grantId === "string" ? grant.grantId : "",
            state: "invalid",
        })));
    }
    const validRevocations = inputRevocations.filter((event) =>
        hasValidatedRevocationAuthority(event, input.authorityValidatedRevocationKeys),
    );
    const invalidRevocations = inputRevocations.filter((event) =>
        !hasValidatedRevocationAuthority(event, input.authorityValidatedRevocationKeys),
    );
    const unscopedInvalidRevocation = invalidRevocations.some((event) =>
        typeof event?.missionId !== "string" || event.missionId.length === 0,
    );
    const grantCounts = new Map<string, number>();
    for (const grant of inputGrants) {
        if (typeof grant?.missionId !== "string" || typeof grant?.grantId !== "string") continue;
        const key = capabilityGrantAuthorityKey(grant.missionId, grant.grantId);
        grantCounts.set(key, (grantCounts.get(key) ?? 0) + 1);
    }
    const grantsWithValidIdentity = inputGrants.filter((grant) =>
        typeof grant?.missionId === "string" && typeof grant?.grantId === "string",
    );
    const states = grantsWithValidIdentity.map((grant): ReducedCapabilityGrant => {
        const key = capabilityGrantAuthorityKey(grant.missionId, grant.grantId);
        const evaluationTime = Date.parse(input.evaluatedAt);
        if (
            !hasValidGrantFingerprint(grant)
            || grantCounts.get(key) !== 1
            || unscopedInvalidRevocation
            || invalidRevocations.some((event) => event?.missionId === grant.missionId)
            || Date.parse(grant.issuedAt) > evaluationTime
            || Date.parse(grant.createdAt) > evaluationTime
        ) return { missionId: grant.missionId, grantId: grant.grantId, state: "invalid" };
        if (validRevocations.some((event) => event.missionId === grant.missionId && event.grantId === grant.grantId)) {
            return { missionId: grant.missionId, grantId: grant.grantId, state: "revoked" };
        }
        if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.parse(input.evaluatedAt)) {
            return { missionId: grant.missionId, grantId: grant.grantId, state: "expired" };
        }
        return { missionId: grant.missionId, grantId: grant.grantId, state: "active" };
    });
    return sortStates(states);
}

function isInstant(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
        month < 1 || month > 12
        || day < 1 || day > daysInMonth[month - 1]
        || hour > 23
        || minute > 59
        || second > 59
        || (match[8] !== "Z" && (Number(match[10]) > 23 || Number(match[11]) > 59))
    ) return false;
    return Number.isFinite(Date.parse(value));
}

function compareStable(left: string, right: string): number {
    return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Pure fail-closed predicate for one capability step. A single grant must
 * cover every reference and the exact effect declared by the owner contract.
 */
export function validateCapabilityGrantCoverage(
    input: CapabilityGrantCoverageInput,
): CapabilityGrantCoverageDecision {
    const deny = (reason: CapabilityGrantCoverageDecision["reason"]): CapabilityGrantCoverageDecision => ({
        valid: false,
        reason,
    });
    if (
        typeof input.missionId !== "string"
        || !input.missionId
        || typeof input.capabilityId !== "string"
        || !input.capabilityId
        || !Object.values(EffectClass).includes(input.effectClass)
        || !Array.isArray(input.inputRefs)
        || input.inputRefs.some((ref) => typeof ref !== "string")
        || !Array.isArray(input.grants)
        || !Array.isArray(input.revocations)
        || !isInstant(input.evaluatedAt)
    ) return deny("invalid_input");
    if (input.revocations.some((event) => typeof event?.missionId !== "string" || event.missionId.length === 0)) {
        return deny("not_covered");
    }
    const contract = input.capabilityContract;
    if (!contract || typeof contract.capabilityId !== "string" || contract.capabilityId !== input.capabilityId) {
        return deny("unknown_capability");
    }
    if (
        !Object.values(EffectClass).includes(contract.effectClass)
        || contract.effectClass !== input.effectClass
        || !Array.isArray(contract.allowedInputRefPrefixes)
        || contract.allowedInputRefPrefixes.some((prefix) => typeof prefix !== "string" || !parseReference(prefix, true))
    ) return deny("not_covered");

    const missionGrants = input.grants.filter((grant) => grant?.missionId === input.missionId);
    const missionRevocations = input.revocations.filter((event) => event?.missionId === input.missionId);
    const reduced = reduceCapabilityGrantLedger({
        grants: missionGrants,
        revocations: missionRevocations,
        evaluatedAt: input.evaluatedAt,
        authorityValidatedRevocationKeys: input.authorityValidatedRevocationKeys,
    });
    const stateByKey = new Map(reduced.map((state) => [capabilityGrantAuthorityKey(state.missionId, state.grantId), state.state]));
    let authorityWasUnavailable = false;
    for (const grant of missionGrants) {
        if (!hasValidGrantFingerprint(grant)) continue;
        if (grant.capabilityId !== input.capabilityId) continue;
        if (stateByKey.get(capabilityGrantAuthorityKey(grant.missionId, grant.grantId)) !== "active") continue;
        if (
            grant.allowedEffectClasses.length !== 1
            || grant.allowedEffectClasses[0] !== contract.effectClass
            || grant.allowedEffectClasses[0] !== input.effectClass
        ) continue;
        if (!Array.isArray(grant.allowedRefPrefixes) || grant.allowedRefPrefixes.some((prefix: string) => !parseReference(prefix, true))) continue;
        const coversEveryReference = input.inputRefs.every((ref) =>
            grant.allowedRefPrefixes.some((prefix: string) => capabilityGrantReferenceMatchesPrefix(ref, prefix))
            && contract.allowedInputRefPrefixes.some((prefix: string) => capabilityGrantReferenceMatchesPrefix(ref, prefix)),
        );
        if (!coversEveryReference) continue;
        const authorityKey = capabilityGrantAuthorityKey(grant.missionId, grant.grantId);
        if (
            !grant.grantorClientId
            || !Number.isSafeInteger(grant.grantorCredentialGeneration)
            || (grant.grantorCredentialGeneration as number) < 1
            || !input.authorityValidatedGrantKeys?.has(authorityKey)
        ) {
            authorityWasUnavailable = true;
            continue;
        }
        return { valid: true, grantId: grant.grantId, reason: "covered" };
    }
    return deny(authorityWasUnavailable ? "authority_unavailable" : "not_covered");
}
