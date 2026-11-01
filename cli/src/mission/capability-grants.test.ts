import { describe, expect, it } from "bun:test";
import { EffectClass } from "./contracts.js";
import type { CapabilityContract, MissionCapabilityGrant, MissionCapabilityRevocation } from "./contracts.js";
import {
    capabilityGrantAuthorityKey,
    capabilityGrantReferenceMatchesPrefix,
    capabilityRevocationAuthorityKey,
    computeCapabilityGrantFingerprint,
    computeCapabilityRevocationFingerprint,
    reduceCapabilityGrantLedger,
    validateCapabilityGrantCoverage,
} from "./capability-grants.js";

const NOW = "2026-11-01T12:00:00.000Z";

function makeGrant(overrides: Partial<MissionCapabilityGrant> = {}): MissionCapabilityGrant {
    const grant: MissionCapabilityGrant = {
        grantId: "grant-a",
        missionId: "mission-a",
        capabilityId: "lifeos.journal.read",
        allowedEffectClasses: [EffectClass.READ],
        allowedRefPrefixes: ["refs/lifeos/journal/"],
        grantorClientId: "operator-one",
        grantorCredentialGeneration: 2,
        grantorAuthorityEpoch: 4,
        issuedAt: NOW,
        expiresAt: null,
        createdAt: NOW,
        fingerprint: "",
        ...overrides,
    };
    grant.fingerprint = computeCapabilityGrantFingerprint(grant);
    return grant;
}

function makeRevocation(overrides: Partial<MissionCapabilityRevocation> = {}): MissionCapabilityRevocation {
    const revocation: MissionCapabilityRevocation = {
        revocationId: "revoke-a",
        missionId: "mission-a",
        grantId: "grant-a",
        revokerClientId: "operator-one",
        revokerCredentialGeneration: 2,
        revokerAuthorityEpoch: 4,
        revokedAt: NOW,
        createdAt: NOW,
        fingerprint: "",
        ...overrides,
    };
    revocation.fingerprint = computeCapabilityRevocationFingerprint(revocation);
    return revocation;
}

const CONTRACT: CapabilityContract = {
    capabilityId: "lifeos.journal.read",
    moduleOwner: "lifeos",
    effectClass: EffectClass.READ,
    requiresApproval: false,
    requiresOwnerVerification: false,
    allowedInputRefPrefixes: ["refs/lifeos/journal/"],
    ownsStorage: false,
};

function evaluate(overrides: Partial<Parameters<typeof validateCapabilityGrantCoverage>[0]> = {}) {
    return validateCapabilityGrantCoverage({
        missionId: "mission-a",
        capabilityId: CONTRACT.capabilityId,
        effectClass: EffectClass.READ,
        inputRefs: ["refs/lifeos/journal/2026-08"],
        capabilityContract: CONTRACT,
        grants: [makeGrant()],
        revocations: [],
        evaluatedAt: NOW,
        authorityValidatedGrantKeys: new Set([capabilityGrantAuthorityKey("mission-a", "grant-a")]),
        ...overrides,
    });
}

describe("internal unit capability grant coverage", () => {
    it("accepts one authority-validated unit grant that covers the whole operation", () => {
        expect(evaluate()).toMatchObject({ valid: true, grantId: "grant-a" });
    });

    it("requires the same Mission and capability", () => {
        expect(evaluate({ missionId: "mission-b" }).valid).toBe(false);
        expect(evaluate({ capabilityId: "lifeos.journal.write" }).valid).toBe(false);
    });

    it("does not combine reference coverage from two unit grants", () => {
        const first = makeGrant({ grantId: "grant-lifeos" });
        const second = makeGrant({
            grantId: "grant-runstead",
            capabilityId: "lifeos.journal.read",
            allowedRefPrefixes: ["refs/runstead/pr/"],
        });
        expect(evaluate({
            inputRefs: ["refs/lifeos/journal/2026-08", "refs/runstead/pr/42"],
            capabilityContract: {
                ...CONTRACT,
                allowedInputRefPrefixes: ["refs/lifeos/journal/", "refs/runstead/pr/"],
            },
            grants: [first, second],
            authorityValidatedGrantKeys: new Set([
                capabilityGrantAuthorityKey("mission-a", "grant-lifeos"),
                capabilityGrantAuthorityKey("mission-a", "grant-runstead"),
            ]),
        }).valid).toBe(false);
    });

    it("rejects effects outside the singular CapabilityContract effect", () => {
        expect(evaluate({
            effectClass: EffectClass.WRITE,
            capabilityContract: { ...CONTRACT, effectClass: EffectClass.WRITE },
        }).valid).toBe(false);
        expect(evaluate({
            grants: [makeGrant({ allowedEffectClasses: [EffectClass.READ, EffectClass.WRITE] })],
        }).valid).toBe(false);
    });

    it("rejects unknown capabilities and Missions without grants", () => {
        expect(evaluate({ capabilityContract: null }).valid).toBe(false);
        expect(evaluate({ grants: [] }).valid).toBe(false);
    });

    it("uses segment boundaries and rejects unauthorized or malformed references", () => {
        for (const ref of [
            "refs/lifeos/journal-private/entry",
            "refs/lifeos/journal/../private",
            "refs/lifeos/journal/%2e%2e/private",
            "refs/lifeos/journal/%252e%252e/private",
            "refs://lifeos/journal/entry",
            "storage://user@lifeos/journal/entry",
            "storage://lifeos/journal/../private",
            "refs/lifeos/journal/%2",
            "refs/lifeos/journal/a?query=b",
            "refs/lifeos/journal/a#fragment",
        ]) {
            expect(evaluate({ inputRefs: [ref] }).valid).toBe(false);
        }
    });

    it("accepts valid namespaced refs and rejects namespace/URI category mixing", () => {
        expect(evaluate({ inputRefs: ["refs/lifeos/journal/2026-08"] }).valid).toBe(true);
        expect(evaluate({
            inputRefs: ["storage://lifeos/journal/2026-08"],
            capabilityContract: {
                ...CONTRACT,
                allowedInputRefPrefixes: ["storage://lifeos/journal/"],
            },
            grants: [makeGrant({ allowedRefPrefixes: ["storage://lifeos/journal/"] })],
        }).valid).toBe(true);
        expect(evaluate({
            inputRefs: ["storage://lifeos/journal/2026-08"],
            capabilityContract: {
                ...CONTRACT,
                allowedInputRefPrefixes: ["storage://lifeos/journal/"],
            },
            grants: [makeGrant({ allowedRefPrefixes: ["refs/lifeos/journal/"] })],
        }).valid).toBe(false);
    });

    it("accepts local file URIs and rejects traversal, sibling paths, and remote authorities", () => {
        expect(capabilityGrantReferenceMatchesPrefix(
            "file:///workspace/project/main.ts",
            "file:///workspace/project/",
        )).toBe(true);
        for (const reference of [
            "file:///workspace/project-private/main.ts",
            "file:///workspace/project/../secret.ts",
            "file:///workspace/project/%2e%2e/secret.ts",
            "file://remote/workspace/project/main.ts",
            "file:////workspace/project/main.ts",
            "storage://workspace/project/main.ts",
            "file:///workspace/project/%2",
        ]) {
            expect(capabilityGrantReferenceMatchesPrefix(reference, "file:///workspace/project/")).toBe(false);
        }
        expect(capabilityGrantReferenceMatchesPrefix(
            "storage://other/workspace/project/main.ts",
            "storage://workspace/workspace/project/",
        )).toBe(false);
    });

    it("fails closed for expired, revoked, or unvalidated issuer provenance", () => {
        expect(evaluate({
            grants: [makeGrant({ expiresAt: "2026-11-01T11:59:59.999Z" })],
        }).valid).toBe(false);
        expect(evaluate({
            grants: [makeGrant({
                issuedAt: "2026-11-01T12:00:00.001Z",
                createdAt: "2026-11-01T12:00:00.001Z",
            })],
        }).valid).toBe(false);
        const revocation = makeRevocation();
        expect(evaluate({ revocations: [revocation] }).valid).toBe(false);
        expect(evaluate({
            revocations: [revocation],
            authorityValidatedRevocationKeys: new Set([
                capabilityRevocationAuthorityKey("mission-a", revocation.revocationId),
            ]),
        }).valid).toBe(false);
        const missingRevokerGeneration = makeRevocation({ revokerCredentialGeneration: null });
        expect(evaluate({
            revocations: [missingRevokerGeneration],
            authorityValidatedRevocationKeys: new Set([
                capabilityRevocationAuthorityKey("mission-a", missingRevokerGeneration.revocationId),
            ]),
        }).valid).toBe(false);
        expect(evaluate({
            revocations: [{ ...makeRevocation(), missionId: "" }],
        }).valid).toBe(false);
        expect(evaluate({ authorityValidatedGrantKeys: undefined }).valid).toBe(false);
        expect(evaluate({ authorityValidatedGrantKeys: new Set() }).valid).toBe(false);
        expect(evaluate({
            grants: [makeGrant({ grantorCredentialGeneration: null })],
        }).valid).toBe(false);
        const corruptProvenance = { ...makeGrant(), grantorClientId: "" };
        expect(evaluate({ grants: [corruptProvenance] }).valid).toBe(false);
    });

    it("rejects impossible calendar dates and malformed timestamp offsets", () => {
        expect(() => makeGrant({ issuedAt: "2026-02-30T12:00:00.000Z" })).toThrow(/timestamp/i);
        expect(() => makeGrant({ expiresAt: "2026-11-31T12:00:00.000Z" })).toThrow(/timestamp/i);
        expect(() => makeGrant({ createdAt: "2026-11-01T12:00:00+24:00" })).toThrow(/timestamp/i);
    });

    it("reduction is deterministic and invalid fingerprints never become active", () => {
        const active = makeGrant({ grantId: "grant-active" });
        const revoked = makeGrant({ grantId: "grant-revoked" });
        const bad = { ...makeGrant({ grantId: "grant-invalid" }), fingerprint: "bad" };
        const states = reduceCapabilityGrantLedger({
            grants: [revoked, bad, active],
            revocations: [makeRevocation({ grantId: "grant-revoked", revocationId: "revoke-b" })],
            evaluatedAt: NOW,
            authorityValidatedRevocationKeys: new Set([
                capabilityRevocationAuthorityKey("mission-a", "revoke-b"),
            ]),
        });
        expect(states.map(({ grantId, state }) => [grantId, state])).toEqual([
            ["grant-active", "active"],
            ["grant-invalid", "invalid"],
            ["grant-revoked", "revoked"],
        ]);
    });

    it("quarantines future and inconsistent revocations without reactivating a revoked grant", () => {
        const grant = makeGrant({
            issuedAt: "2026-11-01T11:00:00.000Z",
            createdAt: "2026-11-01T11:01:00.000Z",
        });
        const authorityValidatedRevocationKeys = new Set([
            capabilityRevocationAuthorityKey("mission-a", "revoke-future"),
            capabilityRevocationAuthorityKey("mission-a", "revoke-future-record"),
            capabilityRevocationAuthorityKey("mission-a", "revoke-inconsistent"),
            capabilityRevocationAuthorityKey("mission-a", "revoke-before-grant"),
            capabilityRevocationAuthorityKey("mission-a", "revoke-valid"),
            capabilityRevocationAuthorityKey("mission-a", "revoke-later"),
        ]);
        const evaluateState = (
            revocations: MissionCapabilityRevocation[],
            evaluatedAt = "2026-11-01T12:30:00.000Z",
        ) => reduceCapabilityGrantLedger({
            grants: [grant],
            revocations,
            evaluatedAt,
            authorityValidatedRevocationKeys,
        })[0]?.state;

        expect(evaluateState([makeRevocation({
            revocationId: "revoke-future",
            revokedAt: "2026-11-01T13:00:00.000Z",
            createdAt: "2026-11-01T13:00:00.000Z",
        })])).toBe("invalid");
        expect(evaluateState([makeRevocation({
            revocationId: "revoke-future-record",
            revokedAt: "2026-11-01T12:15:00.000Z",
            createdAt: "2026-11-01T13:00:00.000Z",
        })])).toBe("invalid");
        expect(evaluateState([makeRevocation({
            revocationId: "revoke-inconsistent",
            revokedAt: "2026-11-01T12:15:00.000Z",
            createdAt: "2026-11-01T12:14:00.000Z",
        })])).toBe("invalid");
        expect(evaluateState([makeRevocation({
            revocationId: "revoke-before-grant",
            revokedAt: "2026-11-01T10:59:00.000Z",
            createdAt: "2026-11-01T11:02:00.000Z",
        })])).toBe("invalid");

        const validEarlier = makeRevocation({
            revocationId: "revoke-valid",
            revokedAt: "2026-11-01T12:15:00.000Z",
            createdAt: "2026-11-01T12:16:00.000Z",
        });
        const futureLater = makeRevocation({
            revocationId: "revoke-later",
            revokedAt: "2026-11-01T13:00:00.000Z",
            createdAt: "2026-11-01T13:01:00.000Z",
        });
        expect(evaluateState([validEarlier])).toBe("revoked");
        expect(evaluateState([futureLater, validEarlier])).toBe("revoked");
        expect(evaluateState([validEarlier, futureLater])).toBe("revoked");
        expect(evaluateState([validEarlier], "2026-11-01T12:10:00.000Z")).toBe("invalid");
    });
});
