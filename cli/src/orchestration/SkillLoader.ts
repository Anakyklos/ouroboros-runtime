/**
 * 📚 SkillLoader
 * 
 * Loads Markdown-based Skills extracted from AionUi and formats them
 * as System Prompts or Contexts for the Ouroboros GatewayOrchestrator.
 */

import { readdir, readFile } from 'fs/promises';
import { join, extname } from 'path';

export interface SkillDefinition {
    id: string;
    name: string;
    description: string;
    content: string; // The raw markdown content with instructions
}

export class SkillLoader {
    private skillsDir: string;

    constructor(skillsDir: string) {
        this.skillsDir = skillsDir;
    }

    /**
     * Scan the skills directory and return a list of available skills.
     */
    async listSkills(): Promise<string[]> {
        try {
            const entries = await readdir(this.skillsDir, { withFileTypes: true });
            const skills: string[] = [];

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    // Skill folders typically contain a SKILL.md or an index.md or <folder>.md
                    skills.push(entry.name);
                }
            }

            return skills;
        } catch (err) {
            console.error(`[SkillLoader] Failed to list skills in ${this.skillsDir}:`, err);
            return [];
        }
    }

    /**
     * Load a specific skill by its ID (folder name).
     */
    async loadSkill(skillId: string): Promise<SkillDefinition | null> {
        try {
            const skillPath = join(this.skillsDir, skillId);

            // Look for SKILL.md first, then <skillId>.md
            let contentPath = join(skillPath, 'SKILL.md');
            try {
                await readFile(contentPath, 'utf-8');
            } catch (err) {
                contentPath = join(skillPath, `${skillId}.md`);
            }

            const rawContent = await readFile(contentPath, 'utf-8');

            // Optionally parse YAML frontmatter here if needed
            // For now, we assume the whole markdown is the system prompt.
            const nameMatch = rawContent.match(/^#\s+(.+)$/m);
            const name = nameMatch ? nameMatch[1].trim() : skillId;

            return {
                id: skillId,
                name,
                description: `Skill: ${name}`,
                content: rawContent
            };

        } catch (err) {
            console.error(`[SkillLoader] Failed to load skill ${skillId}:`, err);
            return null;
        }
    }

    /**
     * Format a loaded skill into a prompt block.
     */
    formatSkillPrompt(skill: SkillDefinition): string {
        return `
========================================
[SKILL SYSTEM PROMPT: ${skill.name}]
========================================
${skill.content}
========================================
`;
    }
}
