import { ITool } from "../../../core/ports/ITool";
import { z } from "zod";
import { join } from "path";

export const FileSystemArgsSchema = z.object({
    action: z.enum(["read", "write", "list", "delete"]),
    path: z.string(),
    content: z.string().optional(),
});

export type FileSystemArgs = z.infer<typeof FileSystemArgsSchema>;

export class FileSystemTool implements ITool<FileSystemArgs, string | string[]> {
    public readonly name = "file_system";
    public readonly description = "Manage files on the local filesystem using Bun native APIs.";
    public readonly schema = FileSystemArgsSchema;

    private basePath: string;

    constructor(basePath: string = process.cwd()) {
        this.basePath = basePath;
    }

    async execute(input: FileSystemArgs): Promise<string | string[]> {
        const targetPath = join(this.basePath, input.path);
        const file = Bun.file(targetPath);

        switch (input.action) {
            case "read":
                if (!(await file.exists())) {
                    throw new Error(`File not found: ${targetPath}`);
                }
                return await file.text();

            case "write":
                if (input.content === undefined) {
                    throw new Error("Content is required for write action");
                }
                await Bun.write(targetPath, input.content);
                return `Successfully wrote to ${input.path}`;

            case "delete":
                // Bun doesn't have a direct delete file API yet, using Node's fs/promises or bun script
                const fs = await import("fs/promises");
                await fs.unlink(targetPath);
                return `Successfully deleted ${input.path}`;

            case "list":
                const glob = new Bun.Glob("*");
                const results: string[] = [];
                for await (const x of glob.scan({ cwd: targetPath, absolute: false })) {
                    results.push(x);
                }
                return results;

            default:
                throw new Error(`Unsupported action: ${input.action}`);
        }
    }
}
