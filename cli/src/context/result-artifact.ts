/** Provider and module neutral handoff data (Issue #78). */

import { createHash } from "node:crypto";
import { containsRawSecret, sanitizeText } from "../mission/sanitize.js";
import { deepFreeze } from "./contracts.js";

export const RESULT_ARTIFACT_VERSION = 1 as const;
const RESULT_ARTIFACT_MAX_CHARS = 4096;
const RESULT_ARTIFACT_MAX_ITEMS = 32;

export interface ResultArtifactReference {
    refId: string;
    owner: string;
    externalRef: string;
    label: string;
}

export interface ResultArtifact {
    contractVersion: typeof RESULT_ARTIFACT_VERSION;
    artifactId: string;
    missionId: string;
    invocationId?: string;
    status: "completed" | "failed" | "blocked" | "waiting";
    outcome?: string;
    artifactRefs: ResultArtifactReference[];
    facts: string[];
    decisions: string[];
    blockers: string[];
    unresolved: string[];
    followUpRefs: string[];
    diagnostics: string[];
}

export type ResultArtifactInput = Omit<ResultArtifact, "contractVersion" | "artifactId">;

/** Create a bounded, sanitized, data-only handoff. Unknown fields fail closed. */
export function createResultArtifact(input: ResultArtifactInput): ResultArtifact {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("ResultArtifact input must be a plain data object");
    }
    const allowed = new Set([
        "missionId", "invocationId", "status", "outcome", "artifactRefs", "facts",
        "decisions", "blockers", "unresolved", "followUpRefs", "diagnostics",
    ]);
    for (const key of Object.keys(input as unknown as Record<string, unknown>)) {
        if (!allowed.has(key)) throw new Error("ResultArtifact has an unsupported field");
    }
    if (!input.missionId || containsRawSecret(input.missionId)) {
        throw new Error("ResultArtifact missionId must be a non-secret identity");
    }
    if (input.invocationId !== undefined && (!input.invocationId || containsRawSecret(input.invocationId))) {
        throw new Error("ResultArtifact invocationId must be a non-secret identity");
    }
    if (!new Set(["completed", "failed", "blocked", "waiting"]).has(input.status)) {
        throw new Error("ResultArtifact status is unsupported");
    }
    const arrays = [input.artifactRefs, input.facts, input.decisions, input.blockers,
        input.unresolved, input.followUpRefs, input.diagnostics];
    if (arrays.some((entries) => !Array.isArray(entries))
        || arrays.reduce((count, entries) => count + entries.length, 0) > RESULT_ARTIFACT_MAX_ITEMS) {
        throw new Error("ResultArtifact exceeds its item limit");
    }
    const cleanText = (value: string): string => {
        if (typeof value !== "string") throw new Error("ResultArtifact text fields must be strings");
        const sanitized = sanitizeText(value).trim();
        if (containsRawSecret(sanitized)) throw new Error("ResultArtifact contains an unredactable secret");
        return sanitized;
    };
    const identityRef = (value: string): string => {
        if (typeof value !== "string" || !value || value.trim() !== value || containsRawSecret(value)) {
            throw new Error("ResultArtifact follow-up reference identity is invalid");
        }
        return value;
    };
    const artifactRefs = input.artifactRefs.map((ref) => {
        if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
            throw new Error("ResultArtifact reference must be a data object");
        }
        const allowedReferenceFields = new Set(["refId", "owner", "externalRef", "label"]);
        if (Object.keys(ref).some((key) => !allowedReferenceFields.has(key))) {
            throw new Error("ResultArtifact reference has an unsupported field");
        }
        if (typeof ref.refId !== "string" || !ref.refId
            || typeof ref.owner !== "string" || !ref.owner
            || typeof ref.externalRef !== "string" || !ref.externalRef
            || [ref.refId, ref.owner, ref.externalRef].some(containsRawSecret)) {
            throw new Error("ResultArtifact reference identity is invalid");
        }
        return { refId: ref.refId, owner: ref.owner, externalRef: ref.externalRef, label: cleanText(ref.label) };
    });
    const artifact: Omit<ResultArtifact, "artifactId"> = {
        contractVersion: RESULT_ARTIFACT_VERSION,
        missionId: input.missionId,
        ...(input.invocationId ? { invocationId: input.invocationId } : {}),
        status: input.status,
        ...(input.outcome !== undefined ? { outcome: cleanText(input.outcome) } : {}),
        artifactRefs,
        facts: input.facts.map(cleanText),
        decisions: input.decisions.map(cleanText),
        blockers: input.blockers.map(cleanText),
        unresolved: input.unresolved.map(cleanText),
        followUpRefs: input.followUpRefs.map(identityRef),
        diagnostics: input.diagnostics.map(cleanText),
    };
    const serialized = JSON.stringify(artifact);
    const chars = serialized.length;
    if (chars > RESULT_ARTIFACT_MAX_CHARS) throw new Error("ResultArtifact exceeds its character budget");
    const artifactId = `result-${createHash("sha256").update(serialized).digest("hex").slice(0, 24)}`;
    const result = { ...artifact, artifactId };
    if (JSON.stringify(result).length > RESULT_ARTIFACT_MAX_CHARS) {
        throw new Error("ResultArtifact exceeds its character budget");
    }
    return deepFreeze(result);
}
