# Antigravity Integration Skill

## Overview
Skill para integrar Ouroboros com Antigravity como "extensão do corpo".

## Activation Triggers
- Keywords: "antigravity", "agy", "sistema nervoso", "extensão corpo"
- Situação: Precisa executar tarefa via Antigravity Provider

## Usage

### Via WaveExecutor
```typescript
import { createAntigravityTask, AntigravityTask } from 'cli/src/orchestration/AntigravityTask.js';
import { createAntigravityProvider } from 'cli/src/providers/antigravity-provider.js';

const provider = createAntigravityProvider({
    workDir: process.cwd(),
    verbose: true,
});

const task: AntigravityTask = createAntigravityTask(
    'task_001',
    'Create a REST API endpoint',
    provider,
    { context: 'Use Express.js and TypeScript' }
);

const waveExecutor = createWaveExecutor(orchestrator);
await waveExecutor.execute([task]);
```

### Via Orchestrator
```typescript
import { createAntigravityProvider } from 'cli/src/providers/antigravity-provider.js';

const provider = createAntigravityProvider({
    workDir: process.cwd(),
});

await orchestrator.executeWithAntigravity(task, provider);
```

## Anti-Vibe Protocol Compliance
- ✅ Spec Phase: Criar spec antes de implementar
- ✅ Validation: Validar saída do Antigravity
- ✅ Implementation: Usar provider nativo
- ✅ Verification: Testar com diferentes prompts

## Patterns
- Use `createAntigravityTask` para criar tasks compatíveis com WaveExecutor
- O Provider gerencia estado automaticamente
- Events são emitidos via EventBus para TUI
- Sessões são persistidas via StoragePort

## Files
- **cli/src/ports/antigravity-port.ts**: Interface hexagonal
- **cli/src/providers/antigravity-provider.ts**: Provider nativo
- **cli/src/adapters/antigravity-adapter.ts**: Implementação subprocess
- **cli/src/orchestration/antigravityTask.ts**: Tipo WaveTask
