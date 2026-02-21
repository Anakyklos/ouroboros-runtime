import { z } from "zod";
import { ITool } from "./ITool";

export interface LLMMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface ToolCall {
    name: string;
    arguments: any;
}

export interface LLMResponse {
    content: string;
    toolCalls?: ToolCall[];
}

export interface ILLMProvider {
    chat(messages: LLMMessage[], tools?: ITool[]): Promise<LLMResponse>;
}
