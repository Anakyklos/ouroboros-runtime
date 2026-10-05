import { describe, expect, it } from "bun:test";

import { makeContextMission } from "./fixtures.js";
import { createResultArtifact } from "./result-artifact.js";

describe("ResultArtifact", () => {
    it("keeps handoffs small, typed, serializable, and free of transcript fields", () => {
        const artifact = createResultArtifact({
            missionId: "mission-1",
            invocationId: "inv-1",
            status: "completed",
            outcome: "review draft prepared",
            artifactRefs: [{ refId: "e-1", owner: "lifeos", externalRef: "refs/lifeos/e-1", label: "journal summary" }],
            facts: ["Three entries were reviewed"],
            decisions: ["Use the current week only"],
            blockers: [],
            unresolved: [],
            followUpRefs: [],
            diagnostics: ["api_key=secret-value"],
        });

        expect(Object.isFrozen(artifact)).toBe(true);
        expect(JSON.stringify(artifact)).not.toContain("secret-value");
        expect(JSON.stringify(artifact)).not.toContain("transcript");
        expect(JSON.stringify(artifact)).not.toContain("CoT");
        expect((artifact as unknown as Record<string, unknown>).transcript).toBeUndefined();
        expect(artifact.diagnostics[0]).not.toContain("secret-value");
        expect(artifact.missionId).toBe("mission-1");
    });

    it("rejects unknown transcript-shaped fields instead of carrying them through", () => {
        expect(() => createResultArtifact({
            missionId: makeContextMission().missionId,
            status: "completed",
            transcript: "full model conversation",
        } as never)).toThrow(/unsupported field/i);
    });

    it("preserves valid follow-up references exactly", () => {
        const reference = "refs/Module/CaseSensitive%2Fhandoff-7";
        const artifact = createResultArtifact({
            missionId: "mission-1",
            status: "completed",
            artifactRefs: [],
            facts: [],
            decisions: [],
            blockers: [],
            unresolved: [],
            followUpRefs: [reference],
            diagnostics: [],
        });

        expect(JSON.parse(JSON.stringify(artifact)).followUpRefs).toEqual([reference]);
        expect(artifact.followUpRefs[0]).toBe(reference);
    });

    it("rejects secret-bearing follow-up identities without rewriting the target", () => {
        for (const reference of [
            "refs/module/api_key=secret-value",
            "refs/module/token=secret-value",
            "refs/module/Bearer abcdefghijklmnop",
            "refs/module/Authorization: Bearer abcdefghijklmnop",
        ]) {
            expect(() => createResultArtifact({
                missionId: "mission-1",
                status: "completed",
                artifactRefs: [],
                facts: [],
                decisions: [],
                blockers: [],
                unresolved: [],
                followUpRefs: [reference],
                diagnostics: [],
            })).toThrow();
        }
    });
});
