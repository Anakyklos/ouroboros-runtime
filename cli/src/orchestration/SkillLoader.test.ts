/**
 * QUARANTINED — excluded from `bun run check:tests` (baseline gate).
 * Recovery debt: https://github.com/RenyEnnos/ouroboros-runtime/issues/41
 * Manifest: scripts/quarantine-manifest.json
 * Do not delete/rename this file to make CI green; fix or keep listed in the manifest.
 */

import { test, expect, describe } from "bun:test";
import { join } from "path";
import { SkillLoader } from "./SkillLoader.js";

describe("SkillLoader", () => {
    test("listSkills() should return an array of available skill directories", async () => {
        // Point to the adapted skills directory in 'engenharia reversa /AionUi/_adapted/skills'
        const skillsDir = join(process.cwd(), "..", "engenharia reversa ", "AionUi", "_adapted", "skills");
        const loader = new SkillLoader(skillsDir);

        const skills = await loader.listSkills();
        expect(Array.isArray(skills)).toBe(true);
        // At least some skills should be present
        expect(skills.length).toBeGreaterThan(0);
        expect(skills).toContain("cowork");
        expect(skills).toContain("pptx");
    });

    test("loadSkill() should parse a specific skill correctly", async () => {
        const skillsDir = join(process.cwd(), "..", "engenharia reversa ", "AionUi", "_adapted", "skills");
        const loader = new SkillLoader(skillsDir);

        const skill = await loader.loadSkill("cowork");
        expect(skill).not.toBeNull();
        expect(skill?.id).toBe("cowork");
        expect(skill?.content).toContain("Cowork assistant");
    });
});
