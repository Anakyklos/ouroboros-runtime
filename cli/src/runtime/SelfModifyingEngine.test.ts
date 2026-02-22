import { describe, it, expect } from 'bun:test';
import { SelfModifyingEngine, SelfModifyingEngineConfig } from './SelfModifyingEngine';

describe('SelfModifyingEngine', () => {
    const config: SelfModifyingEngineConfig = {
        sourceDir: '/tmp/ouroboros-test',
        validateSyntax: false,
        runTestsAfter: false,
        autoGitCommit: false
    };

    const engine = new SelfModifyingEngine(config);

    const extractExports = (code: string): string[] => {
        return (engine as any).extractExports(code);
    };

    const extractMatches = (pattern: RegExp, code: string, groupIndex?: number): string[] => {
        return (SelfModifyingEngine as any).extractMatches(pattern, code, groupIndex);
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

    it('should extract identifiers with $', () => {
        const code = `
            export const $foo = 1;
            export function $bar() {}
            export class $Baz {}
        `;
        expect(extractExports(code).sort()).toEqual(['$foo', '$bar', '$Baz'].sort());
    });

    it('should extract identifiers starting with _', () => {
        const code = `
            export const _foo = 1;
            export function _bar() {}
            export class _Baz {}
        `;
        expect(extractExports(code).sort()).toEqual(['_foo', '_bar', '_Baz'].sort());
    });

    it('should extract identifiers with unicode characters', () => {
        const code = `
            export const café = 1;
            export function ümlaut() {}
            export class Ångström {}
        `;
        expect(extractExports(code).sort()).toEqual(['café', 'ümlaut', 'Ångström'].sort());
    });

    it('should throw error if pattern is not global', () => {
        const pattern = /test/i;
        expect(() => extractMatches(pattern, 'test')).toThrow('Pattern must be global');
    });

    it('should throw error if capture group does not exist', () => {
        const pattern = /test/g;
        expect(() => extractMatches(pattern, 'test')).toThrow('does not contain capture group');
    });

    it('should allow extracting full match (group 0)', () => {
        const pattern = /test/g;
        expect(extractMatches(pattern, 'test test', 0)).toEqual(['test', 'test']);
    });
});
