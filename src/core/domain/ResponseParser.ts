import { ITool } from "../ports/ITool";
import { ToolCall } from "../ports/ILLMProvider";

export class ResponseParser {

    /**
     * Executes the requested tool calls and returns an array of result messages.
     */
    static async executeToolCalls(toolCalls: ToolCall[], availableTools: ITool[]): Promise<string[]> {
        const results: string[] = [];

        for (const call of toolCalls) {
            const tool = availableTools.find(t => t.name === call.name);

            if (!tool) {
                results.push(`Tool ${call.name} not found.`);
                continue;
            }

            try {
                // Parse arguments ensuring they match the Zod schema
                const parsedArgs = tool.schema.parse(call.arguments);
                const output = await tool.execute(parsedArgs);
                results.push(`Tool ${call.name} succeeded.\nOutput:\n${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}`);
            } catch (error: any) {
                results.push(`Tool ${call.name} failed.\nError: ${error.message}`);
            }
        }

        return results;
    }
}
