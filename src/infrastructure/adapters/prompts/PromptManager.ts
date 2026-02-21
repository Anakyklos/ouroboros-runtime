import { IPromptManager } from "../../../core/ports/IPromptManager";
import { join } from "path";

export class PromptManager implements IPromptManager {
    private promptsDir: string;

    constructor(promptsDir: string) {
        this.promptsDir = promptsDir;
    }

    async loadPromptTemplate(templateName: string): Promise<string> {
        const filePath = join(this.promptsDir, `${templateName}.md`);
        const file = Bun.file(filePath);

        if (!(await file.exists())) {
            throw new Error(`Prompt template not found: ${templateName} at ${filePath}`);
        }

        return await file.text();
    }

    async renderPrompt(templateName: string, variables: Record<string, string>): Promise<string> {
        let template = await this.loadPromptTemplate(templateName);

        for (const [key, value] of Object.entries(variables)) {
            // Handle common {{key}} template format
            const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
            template = template.replace(regex, value);
        }

        return template;
    }
}
