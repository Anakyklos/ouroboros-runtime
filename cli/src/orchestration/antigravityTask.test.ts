import { describe, it, expect } from 'bun:test';
import { createAntigravityProvider, type AntigravityProvider } from '../../providers/antigravity-provider.js';
import { AntigravityAdapter } from '../../adapters/antigravity-adapter.js';

describe('Antigravity Integration', () => {
    describe('AntigravityAdapter', () => {
        it('deve executar prompt simples', async () => {
            const config = {};
            const adapter = new AntigravityAdapter(config);
            
            const result = await adapter.execute({
                prompt: 'Say hello',
            });
            
            expect(result.success).toBe(true);
            expect(result.content).toContain('hello');
        });
        
        it('deve gerenciar estado corretamente', async () => {
            const config = {};
            const adapter = new AntigravityAdapter(config);
            const state = await adapter.getState();
            
            expect(state).not.toBeNull();
            expect(state.status).toBe('idle');
        });
    });
    
    describe('AntigravityProvider', () => {
        it('deve inicializar corretamente', async () => {
            const config = {};
            const adapter = new AntigravityAdapter(config);
            const provider = createAntigravityProvider({
                workDir: process.cwd(),
            }, adapter);
            
            await provider.initialize();
            const state = await provider.getState();
            
            expect(state).not.toBeNull();
        });
        
        it('deve executar prompt', async () => {
            const config = {};
            const adapter = new AntigravityAdapter(config);
            const provider = createAntigravityProvider({
                workDir: process.cwd(),
            }, adapter);
            
            const result = await provider.execute('Tell me a joke');
            
            expect(result.success).toBe(true);
            expect(result.content.length).toBeGreaterThan(0);
        });
    });
});
            
            expect(result.success).toBe(true);
            expect(result.content).toContain('hello');
        });
        
        it('deve gerenciar estado corretamente', async () => {
            const adapter = new AntigravityAdapter({});
            const state = await adapter.getState();
            
            expect(state).not.toBeNull();
            expect(state.status).toBe('idle');
        });
    });
    
    describe('AntigravityProvider', () => {
        it('deve inicializar corretamente', async () => {
            const adapter = new AntigravityAdapter({});
            const provider = createAntigravityProvider({
                workDir: process.cwd(),
            }, adapter);
            
            await provider.initialize();
            const state = await provider.getState();
            
            expect(state).not.toBeNull();
        });
        
        it('deve executar prompt', async () => {
            const adapter = new AntigravityAdapter({});
            const provider = createAntigravityProvider({
                workDir: process.cwd(),
            }, adapter);
            
            const result = await provider.execute('Tell me a joke');
            
            expect(result.success).toBe(true);
            expect(result.content.length).toBeGreaterThan(0);
        });
    });
});
