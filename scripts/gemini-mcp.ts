/**
 * 💎 Gemini MCP Server
 * 
 * Exposes Gemini CLI capabilities to Claude (IDE) via Model Context Protocol.
 * 
 * Protocol: JSON-RPC 2.0 over Standard Input/Output.
 */

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';

interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: number | string;
    method: string;
    params?: any;
}

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: number | string;
    result?: any;
    error?: any;
}

/**
 * Executes Gemini CLI query
 */
async function runGeminiQuery(prompt: string, model: string = "flash"): Promise<string> {
    return new Promise((resolve, reject) => {
        // The gemini CLI expects the prompt after the -p flag or as positional
        // If -p is used without an argument, it might fail.
        // Let's use positional prompt with -p flag for non-interactive mode.
        const gemini = spawn('gemini', ['-p', prompt, '-m', model]);
        let output = '';
        let error = '';

        gemini.stdout.on('data', (data) => output += data.toString());
        gemini.stderr.on('data', (data) => error += data.toString());

        gemini.on('close', (code) => {
            if (code === 0) {
                resolve(output.trim());
            } else {
                reject(new Error(error || `Gemini failed with code ${code}`));
            }
        });
    });
}

/**
 * MCP Method Handlers
 */
const handlers: Record<string, (params: any) => Promise<any>> = {
    "initialize": async () => ({
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: {
            name: "gemini-mcp-bridge",
            version: "0.1.0"
        }
    }),
    "notifications/initialized": async () => null,
    "tools/list": async () => ({
        tools: [
            {
                name: "gemini_query",
                description: "Executes a query using Gemini CLI. Best for web searches, GitHub analysis, and long-term memory retrieval.",
                inputSchema: {
                    type: "object",
                    properties: {
                        prompt: { type: "string", description: "The prompt to send to Gemini" },
                        model: { type: "string", enum: ["flash", "pro"], default: "flash", description: "Gemini model to use" }
                    },
                    required: ["prompt"]
                }
            }
        ]
    }),
    "tools/call": async (params: { name: string, arguments: any }) => {
        if (params.name === "gemini_query") {
            try {
                const text = await runGeminiQuery(params.arguments.prompt, params.arguments.model);
                return {
                    content: [
                        { type: "text", text }
                    ]
                };
            } catch (err) {
                return {
                    isError: true,
                    content: [
                        { type: "text", text: String(err) }
                    ]
                };
            }
        }
        throw new Error(`Tool not found: ${params.name}`);
    }
};

/**
 * Main Loop: Read JSON-RPC from Stdin
 */
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', async (line: string) => {
    try {
        const request = JSON.parse(line) as JsonRpcRequest;
        const handler = handlers[request.method];

        if (handler) {
            const result = await handler(request.params);
            if (request.id !== undefined) {
                console.log(JSON.stringify({
                    jsonrpc: "2.0",
                    id: request.id,
                    result
                }));
            }
        } else {
            if (request.id !== undefined) {
                console.log(JSON.stringify({
                    jsonrpc: "2.0",
                    id: request.id,
                    error: { code: -32601, message: "Method not found" }
                }));
            }
        }
    } catch (err) {
        // Ignore parse errors or handle them
    }
});

// Signal that we are ready
process.stderr.write("Gemini MCP Server Started\n");
