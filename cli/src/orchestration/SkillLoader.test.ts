import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SkillLoader } from "./SkillLoader.js";

const temporaryDirectories: string[] = [];

async function createTemporarySkillsDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "ouroboros-skillloader-"));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
        expect(existsSync(directory)).toBe(false);
    }
});

describe("SkillLoader", () => {
    test("listSkills() finds skill directories and ignores loose files", async () => {
        const skillsDir = await createTemporarySkillsDirectory();
        await mkdir(join(skillsDir, "primary"));
        await writeFile(join(skillsDir, "primary", "SKILL.md"), "# Primary skill\nFixture content.");
        await mkdir(join(skillsDir, "fallback"));
        await writeFile(join(skillsDir, "fallback", "fallback.md"), "# Fallback skill\nFixture content.");
        await writeFile(join(skillsDir, "loose.md"), "# Loose file\nNot a skill directory.");

        const skills = await new SkillLoader(skillsDir).listSkills();

        expect(skills).toHaveLength(2);
        expect(skills).toContain("primary");
        expect(skills).toContain("fallback");
        expect(skills).not.toContain("loose.md");
    });

    test("loadSkill() reads SKILL.md and derives the name from its Markdown heading", async () => {
        const skillsDir = await createTemporarySkillsDirectory();
        const content = "# Fixture skill name\n\nOnly controlled fixture content.";
        await mkdir(join(skillsDir, "fixture-skill"));
        await writeFile(join(skillsDir, "fixture-skill", "SKILL.md"), content);

        const skill = await new SkillLoader(skillsDir).loadSkill("fixture-skill");

        expect(skill).not.toBeNull();
        expect(skill?.id).toBe("fixture-skill");
        expect(skill?.name).toBe("Fixture skill name");
        expect(skill?.content).toBe(content);
    });

    test("loadSkill() falls back to <skillId>.md", async () => {
        const skillsDir = await createTemporarySkillsDirectory();
        const content = "# Fallback heading\n\nFallback fixture content.";
        await mkdir(join(skillsDir, "fallback-skill"));
        await writeFile(join(skillsDir, "fallback-skill", "fallback-skill.md"), content);

        const skill = await new SkillLoader(skillsDir).loadSkill("fallback-skill");

        expect(skill).not.toBeNull();
        expect(skill?.name).toBe("Fallback heading");
        expect(skill?.content).toBe(content);
    });

    test("missing or inaccessible skills fail honestly with empty results", async () => {
        const skillsDir = await createTemporarySkillsDirectory();
        const inaccessibleSkillsDir = join(skillsDir, "does-not-exist");
        const errorSpy = spyOn(console, "error").mockImplementation(() => {});

        try {
            const loader = new SkillLoader(inaccessibleSkillsDir);

            expect(await loader.listSkills()).toEqual([]);
            expect(await loader.loadSkill("missing-skill")).toBeNull();
        } finally {
            errorSpy.mockRestore();
        }
    });
});
