/**
 * 💾 VariableStore
 *
 * Gerencia variáveis de contexto e substituição de templates.
 * Substitui {{variable_name}} por valores reais em strings.
 */

import type { WorkflowContext, WorkflowVariable } from './types/workflow-types.js';

export class VariableStore {
    private context: WorkflowContext;

    constructor(initialVariables: Record<string, unknown> = {}) {
        this.context = {
            variables: { ...initialVariables },
            outputs: {},
            stepResults: {},
        };
    }

    setVariable(name: string, value: unknown): void {
        this.context.variables[name] = value;
    }

    getVariable(name: string): unknown {
        return this.context.variables[name];
    }

    setOutput(stepId: string, outputName: string, value: unknown): void {
        if (!this.context.outputs[stepId]) {
            this.context.outputs[stepId] = {};
        }
        (this.context.outputs[stepId] as Record<string, unknown>)[outputName] = value;
    }

    getOutput(stepId: string, outputName: string): unknown {
        return this.context.outputs[stepId]?.[outputName];
    }

    setStepResult(stepId: string, result: unknown): void {
        this.context.stepResults[stepId] = result;
    }

    getStepResult(stepId: string): unknown {
        return this.context.stepResults[stepId];
    }

    getContext(): WorkflowContext {
        return { ...this.context };
    }

    substitute(template: string): string {
        if (!template || typeof template !== 'string') {
            return template;
        }

        return template.replace(/\{\{([^}]+)\}\}/g, (match, expression) => {
            const trimmed = expression.trim();

            if (trimmed.startsWith('outputs.')) {
                const [_, stepId, outputName] = trimmed.split('.');
                const value = this.getOutput(stepId, outputName);
                return String(value ?? match);
            } else if (trimmed.startsWith('results.')) {
                const stepId = trimmed.substring('results.'.length);
                const value = this.getStepResult(stepId);
                return String(value ?? match);
            } else {
                const value = this.getVariable(trimmed);
                return String(value ?? match);
            }
        });
    }

    substituteObject<T>(obj: T): T {
        if (obj === null || obj === undefined) {
            return obj;
        }

        if (typeof obj === 'string') {
            return this.substitute(obj) as T;
        }

        if (Array.isArray(obj)) {
            return obj.map(item => this.substituteObject(item)) as T;
        }

        if (typeof obj === 'object') {
            const result: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
                result[key] = this.substituteObject(value);
            }
            return result as T;
        }

        return obj;
    }

    loadVariables(variables: WorkflowVariable[]): void {
        for (const variable of variables) {
            if (variable.required && variable.value === undefined) {
                throw new Error(`Required variable "${variable.name}" is not defined`);
            }
            this.setVariable(variable.name, variable.value);
        }
    }

    validateVariables(variables: WorkflowVariable[]): boolean {
        for (const variable of variables) {
            if (variable.required && this.getVariable(variable.name) === undefined) {
                return false;
            }
        }
        return true;
    }

    reset(): void {
        this.context = {
            variables: {},
            outputs: {},
            stepResults: {},
        };
    }

    clone(): VariableStore {
        const clone = new VariableStore();
        clone.context = JSON.parse(JSON.stringify(this.context));
        return clone;
    }
}

export function createVariableStore(
    initialVariables: Record<string, unknown> = {}
): VariableStore {
    return new VariableStore(initialVariables);
}
