/**
 * 🔌 RPC Port
 * 
 * Interface para comunicação JSON-RPC 2.0.
 * Define o contrato do gateway RPC.
 */

export interface RpcRequest {
    jsonrpc: '2.0';
    id: string | number | null;
    method: string;
    params?: Record<string, unknown>;
    apiKey?: string;
}

export interface RpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: unknown;
    error?: RpcError;
}

export interface RpcError {
    code: number;
    message: string;
    data?: unknown;
}

// Standard JSON-RPC error codes
export const RPC_ERROR_CODES = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    // Custom codes (-32000 to -32099)
    SESSION_NOT_FOUND: -32001,
    SESSION_ALREADY_EXISTS: -32002,
    UNAUTHORIZED: -32003,
} as const;

export type RpcMethodHandler = (params: Record<string, unknown>) => Promise<unknown>;

export interface RpcPort {
    registerMethod(name: string, handler: RpcMethodHandler): void;
    handleRequest(request: RpcRequest): Promise<RpcResponse>;
}

export interface DaemonConfig {
    port: number;
    host: string;
    sessionToken?: string;
    apiKey?: string;
}

