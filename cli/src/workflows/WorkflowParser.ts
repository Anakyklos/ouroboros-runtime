/**
 * 📜 WorkflowParser
 *
 * Converte JSON/YAML em objetos Workflow.
 * Valida estrutura e tipos.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Workflow, WorkflowVariable } from './types/workflow-types.js';
import { createVariableStore } from './VariableStore.js';

export class WorkflowParser {
    static fromFile(filePath: string): Workflow {
        if (!existsSync(filePath)) {
            throw new Error(`Workflow file not found: ${filePath}`);
        }

        const content = readFileSync(filePath, 'utf-8');
        return this.fromJSON(content);
    }

    static fromJSON(jsonString: string): Workflow {
        try {
            const workflow = JSON.parse(jsonString) as Workflow;
            return this.validate(workflow);
        } catch (error) {
            throw new Error(
                `Failed to parse workflow JSON: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private static validate(workflow: Workflow): Workflow {
        if (!workflow.name) {
            throw new Error('Workflow must have a name');
        }

        if (!workflow.version) {
            throw new Error('Workflow must have a version');
        }

        if (!workflow.description) {
            throw new Error('Workflow must have a description');
        }

        if (!workflow.meta || !workflow.meta.author) {
            throw new Error('Workflow must have meta.author');
        }

        if (!Array.isArray(workflow.variables)) {
            throw new Error('Workflow variables must be an array');
        }

        if (!Array.isArray(workflow.steps)) {
            throw new Error('Workflow steps must be an array');
        }

        if (workflow.steps.length === 0) {
            throw new Error('Workflow must have at least one step');
        }

        const stepIds = new Set<string>();

        for (const step of workflow.steps) {
            if (!step.id) {
                throw new Error('Step must have an id');
            }

            if (stepIds.has(step.id)) {
                throw new Error(`Duplicate step id: ${step.id}`);
            }

            stepIds.add(step.id);

            if (!step.name) {
                throw new Error(`Step ${step.id} must have a name`);
            }

            if (!step.agent) {
                throw new Error(`Step ${step.id} must have an agent`);
            }

            if (!step.prompt) {
                throw new Error(`Step ${step.id} must have a prompt`);
            }

            if (step.dependsOn && Array.isArray(step.dependsOn)) {
                for (const dep of step.dependsOn) {
                    if (!stepIds.has(dep)) {
                        throw new Error(`Step ${step.id} depends on unknown step: ${dep}`);
                    }
                }
            }
        }

        if (workflow.onFailure && !workflow.onFailure.action) {
            throw new Error('Workflow onFailure must have an action');
        }

        return workflow;
    }

    static substituteVariables(
        workflow: Workflow,
        variables: Record<string, unknown>
    ): Workflow {
        const store = createVariableStore(variables);

        const substitutedVariables = workflow.variables.map(variable => ({
            ...variable,
            value: store.substituteObject(variable.value),
        }));

        const substitutedSteps = workflow.steps.map(step => ({
            ...step,
            prompt: store.substitute(step.prompt),
            description: step.description ? store.substitute(step.description) : undefined,
        }));

        return {
            ...workflow,
            variables: substitutedVariables,
            steps: substitutedSteps,
        };
    }

    static promptForMissingVariables(
        workflow: Workflow,
        providedVariables: Record<string, unknown>
    ): Record<string, unknown> {
        const variables: Record<string, unknown> = { ...providedVariables };

        for (const variable of workflow.variables) {
            if (variable.required && variables[variable.name] === undefined) {
                throw new Error(
                    `Required variable "${variable.name}" is missing: ${variable.description || ''}`
                );
            }
        }

        return variables;
    }

    static createVariableStore(
        workflow: Workflow,
        providedVariables: Record<string, unknown>
    ) {
        const variables = this.promptForMissingVariables(workflow, providedVariables);
        const store = createVariableStore(variables);
        store.loadVariables(workflow.variables);
        return store;
    }
}

export function createWorkflowParser(): WorkflowParser {
    return new WorkflowParser();
}
