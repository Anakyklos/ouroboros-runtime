/**
 * 🧠 Memory Manager
 * 
 * Sistema de memória persistente inspirado no OpenClaw.
 * Salva histórico em Markdown para consulta posterior.
 * 
 * Abordagem "File-first": Markdown como fonte da verdade,
 * legível por humanos e versionável via Git.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TaskResult, ContextEntry } from "./types.js";

const MEMORY_DIR = ".agent/memory";

/**
 * Formata data como YYYY-MM-DD
 */
function formatDate(date: Date = new Date()): string {
    return date.toISOString().split("T")[0];
}

/**
 * Garante que o diretório de memória existe.
 */
function ensureMemoryDir(projectRoot: string = process.cwd()): string {
    const memPath = path.join(projectRoot, MEMORY_DIR);
    if (!fs.existsSync(memPath)) {
        fs.mkdirSync(memPath, { recursive: true });
    }
    return memPath;
}

/**
 * Retorna o caminho do arquivo de log diário.
 */
function getDailyLogPath(projectRoot?: string): string {
    const memDir = ensureMemoryDir(projectRoot);
    return path.join(memDir, `${formatDate()}.md`);
}

/**
 * Serializa ContextEntry para Markdown.
 */
function contextToMarkdown(entry: ContextEntry, index: number): string {
    const time = entry.timestamp.toISOString().split("T")[1].split(".")[0];
    const status = entry.error ? `❌ FAILED: ${entry.error}` : "✅ OK";

    return `
### Attempt ${index + 1} (${time})
- **Persona**: ${entry.persona}
- **Status**: ${status}

<details>
<summary>Prompt</summary>

\`\`\`
${entry.prompt.slice(0, 500)}${entry.prompt.length > 500 ? "..." : ""}
\`\`\`

</details>

<details>
<summary>Output</summary>

\`\`\`
${entry.output.slice(0, 1000)}${entry.output.length > 1000 ? "..." : ""}
\`\`\`

</details>
`;
}

/**
 * Serializa TaskResult para Markdown.
 */
function taskResultToMarkdown(taskId: string, result: TaskResult): string {
    const statusEmoji = result.status === "SUCCESS" ? "✅" :
        result.status === "NEEDS_HUMAN" ? "🆘" : "❌";

    let md = `
## Task: ${taskId} ${statusEmoji}

- **Status**: ${result.status}
- **Persona**: ${result.persona}
- **Retries**: ${result.retryCount}
- **Duration**: ${result.durationMs}ms
- **Time**: ${new Date().toISOString()}

`;

    if (result.error) {
        md += `### Error\n\`\`\`\n${result.error}\n\`\`\`\n\n`;
    }

    if (result.contextHistory && result.contextHistory.length > 0) {
        md += `### Execution History\n`;
        result.contextHistory.forEach((entry, i) => {
            md += contextToMarkdown(entry, i);
        });
    }

    md += `---\n`;
    return md;
}

/**
 * Manager para memória persistente.
 */
export class MemoryManager {
    private projectRoot: string;

    constructor(projectRoot: string = process.cwd()) {
        this.projectRoot = projectRoot;
        ensureMemoryDir(projectRoot);
    }

    /**
     * Salva resultado de task no log diário.
     */
    saveTaskResult(taskId: string, result: TaskResult): void {
        const logPath = getDailyLogPath(this.projectRoot);
        const markdown = taskResultToMarkdown(taskId, result);

        // Append to daily log
        fs.appendFileSync(logPath, markdown, "utf-8");
        console.log(`[MemoryManager] 📝 Saved task ${taskId} to ${logPath}`);
    }

    /**
     * Carrega contexto de hoje e ontem (como OpenClaw faz).
     */
    loadRecentContext(): string {
        const today = formatDate();
        const yesterday = formatDate(new Date(Date.now() - 86400000));

        let context = "";

        for (const date of [yesterday, today]) {
            const logPath = path.join(ensureMemoryDir(this.projectRoot), `${date}.md`);
            if (fs.existsSync(logPath)) {
                context += `\n\n# Log ${date}\n`;
                context += fs.readFileSync(logPath, "utf-8");
            }
        }

        return context || "No recent memory found.";
    }

    /**
     * Gera resumo do dia (auto-summary).
     */
    generateDailySummary(): string {
        const logPath = getDailyLogPath(this.projectRoot);
        if (!fs.existsSync(logPath)) {
            return "No tasks executed today.";
        }

        const content = fs.readFileSync(logPath, "utf-8");
        const taskMatches = content.match(/## Task: .+ [✅❌🆘]/g) || [];
        const successCount = (content.match(/Status: SUCCESS/g) || []).length;
        const failCount = taskMatches.length - successCount;

        return `
## Daily Summary (${formatDate()})
- **Total Tasks**: ${taskMatches.length}
- **Success**: ${successCount}
- **Failed/Escalated**: ${failCount}
`;
    }

    /**
     * Retorna o diretório de memória.
     */
    getMemoryDir(): string {
        return ensureMemoryDir(this.projectRoot);
    }
}

/**
 * Factory function.
 */
export function createMemoryManager(projectRoot?: string): MemoryManager {
    return new MemoryManager(projectRoot);
}
