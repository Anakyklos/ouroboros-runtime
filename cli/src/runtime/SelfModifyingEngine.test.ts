import { describe, it, expect } from 'bun:test';
import { SelfModifyingEngine, SelfModifyingEngineConfig } from './SelfModifyingEngine';

describe('SelfModifyingEngine', () => {
    // Create a minimal config for testing
    const config: SelfModifyingEngineConfig = {
        sourceDir: '/tmp/ouroboros-test',
        validateSyntax: false, // disable external deps for unit test
        runTestsAfter: false,
        autoGitCommit: false
    };

    const engine = new SelfModifyingEngine(config);

    // Helper to access private method
    const extractExports = (code: string): string[] => {
        return (engine as any).extractExports(code);
    };

    it('should extract function exports', () => {
        const code = `
            export function hello() {}
            export function world(a: number) {}
            function internal() {}
        `;
        expect(extractExports(code)).toEqual(['hello', 'world']);
    });

    it('should extract async function exports', () => {
        const code = `
            export async function fetchData() {}
            async function internal() {}
        `;
        expect(extractExports(code)).toEqual(['fetchData']);
    });

    it('should extract class exports', () => {
        const code = `
            export class User {}
            class Helper {}
        `;
        expect(extractExports(code)).toEqual(['User']);
    });

    it('should extract const exports', () => {
        const code = `
            export const PI = 3.14;
            export const config = {};
            const secret = 'hidden';
        `;
        expect(extractExports(code)).toEqual(['PI', 'config']);
    });

    it('should extract interface exports', () => {
        const code = `
            export interface Config {}
            interface Internal {}
        `;
        expect(extractExports(code)).toEqual(['Config']);
    });

    it('should extract type exports', () => {
        const code = `
            export type ID = string;
            type InternalID = number;
        `;
        expect(extractExports(code)).toEqual(['ID']);
    });

    it('should handle mixed exports', () => {
        const code = `
            export const A = 1;
            export function B() {}
            export class C {}
        `;
        expect(extractExports(code).sort()).toEqual(['A', 'B', 'C'].sort());
    });

    it('should return empty array when no exports found', () => {
        const code = `
            const a = 1;
            function b() {}
        `;
        expect(extractExports(code)).toEqual([]);
    });
});
