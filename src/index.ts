// ============================================================================
// Ouroboros Runtime - Public API
// ============================================================================

// Core Agent Facade
export { OuroborosAgent, type OuroborosAgentOptions } from "./OuroborosAgent";
export { DynamicPromptBuilder } from "./core/domain/services/DynamicPromptBuilder";

// Tools
export { HashlineEditTool } from "./infrastructure/adapters/tools/HashlineEditTool";
export { FileSystemTool } from "./infrastructure/adapters/tools/FileSystemTool";
export { ShellTool } from "./infrastructure/adapters/tools/ShellTool";
export { GitTool } from "./infrastructure/adapters/tools/GitTool";
export { GitHubTool } from "./infrastructure/adapters/tools/GitHubTool";
export { WebSearchTool } from "./infrastructure/adapters/tools/WebSearchTool";

// Oh My OpenCode Workflows
export { SisyphusOrchestratorWorkflow } from "./workflows/opencode/SisyphusOrchestratorWorkflow";
export { HephaestusWorkerWorkflow } from "./workflows/opencode/HephaestusWorkerWorkflow";

// Auto-Claude Workflows
export { PRAgentWorkflow } from "./workflows/github/PRAgentWorkflow";
export { IssueTriagerWorkflow } from "./workflows/github/IssueTriagerWorkflow";
