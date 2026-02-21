import { z } from "zod";
import { ITool } from "../../../core/ports/ITool";
import { HashlineEditAdapter } from "./hashline/adapters/HashlineEditAdapter";
import type { HashlineEdit } from "./hashline/domain/hashline/types";

const HashlineEditSchema = z.object({
    action: z.enum(["read", "edit"]),
    filePath: z.string().describe("The absolute path to the file"),
    edits: z.array(
        z.object({
            type: z.enum(["set_line", "replace_lines", "insert_after"]),
            lineHash: z.string().describe("The LINE#ID anchor reference (e.g., '14#VK')"),
            newLineHash: z.string().optional().describe("For replace_lines: the end LINE#ID anchor"),
            content: z.string().describe("The new content to write"),
        })
    ).optional().describe("The edits to apply (only required for 'edit' action)"),
});

type HashlineEditInput = z.infer<typeof HashlineEditSchema>;

export class HashlineEditTool implements ITool<HashlineEditInput, string> {
    name = "hashline_edit";
    description = "A safe file editor that reads and writes using content hashes (LINE#ID) instead of line numbers, avoiding hallucination errors. Use 'read' to get the file content with hashes, and 'edit' to apply modifications using those hashes.";
    schema = HashlineEditSchema;

    private adapter: HashlineEditAdapter;

    constructor() {
        this.adapter = new HashlineEditAdapter();
    }

    async execute(input: HashlineEditInput): Promise<string> {
        try {
            if (input.action === "read") {
                return await this.adapter.read(input.filePath);
            } else if (input.action === "edit") {
                if (!input.edits) {
                    throw new Error("The 'edits' array is required for the 'edit' action.");
                }

                // Map input schema to domain types
                const domainEdits: HashlineEdit[] = input.edits.map(edit => {
                    switch (edit.type) {
                        case "set_line":
                            return {
                                type: "set_line",
                                line: edit.lineHash,
                                text: edit.content
                            };
                        case "replace_lines":
                            if (!edit.newLineHash) {
                                throw new Error("replace_lines requires newLineHash");
                            }
                            return {
                                type: "replace_lines",
                                start_line: edit.lineHash,
                                end_line: edit.newLineHash,
                                text: edit.content
                            };
                        case "insert_after":
                            return {
                                type: "insert_after",
                                line: edit.lineHash,
                                text: edit.content
                            };
                        default:
                            throw new Error(`Unknown edit type: ${edit.type}`);
                    }
                });

                return await this.adapter.edit(input.filePath, domainEdits);
            }
            throw new Error(`Invalid action: ${input.action}`);
        } catch (error: any) {
            return `Error in HashlineEditTool: ${error.message}`;
        }
    }
}
