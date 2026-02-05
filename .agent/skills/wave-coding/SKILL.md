---
name: Wave Coding
description: Como orquestrar tasks paralelas em waves usando WaveExecutor
---

# Wave Coding

Skill para executar múltiplas tasks em paralelo, respeitando dependências.

## Quando Usar

- 2+ tasks independentes podem rodar em paralelo
- Tasks têm dependências claras (Wave 2 depende de Wave 1)
- Precisa de execução coordenada com controle de concorrência

## Módulo Principal

`cli/src/orchestration/WaveExecutor.ts` - `WaveExecutor`

## Decision Tree

```
São tasks independentes?
  ├─ NÃO → Executar sequencialmente
  └─ SIM → Podem ser decompostas em domínios claros?
           ├─ NÃO → Executar sequencialmente
           └─ SIM → 2+ problemas independentes?
                    ├─ NÃO → Single task
                    └─ SIM → ✅ WAVE CODING
```

## Definir Tasks

```typescript
import { WaveTask } from '../orchestration/wave-types.js';

const tasks: WaveTask[] = [
    // Wave 1 - Sem dependências (paralelo)
    {
        id: 'create-module-a',
        name: 'Create Module A',
        description: 'Implement feature A',
        execute: async () => { /* implementation */ },
    },
    {
        id: 'create-module-b',
        name: 'Create Module B',
        description: 'Implement feature B',
        execute: async () => { /* implementation */ },
    },
    // Wave 2 - Depende de Wave 1
    {
        id: 'integration-tests',
        name: 'Integration Tests',
        description: 'Test A and B together',
        dependsOn: ['create-module-a', 'create-module-b'],
        execute: async () => { /* tests */ },
    },
];
```

## Executar Waves

```typescript
import { createWaveExecutor } from '../orchestration/WaveExecutor.js';

const executor = createWaveExecutor({
    maxConcurrent: 3,        // Max tasks paralelas
    stopOnFirstFailure: true, // Para se qualquer falhar
});

const result = await executor.execute(tasks);

if (result.success) {
    console.log(`Completed in ${result.totalDuration}ms`);
} else {
    console.log('Failed tasks:', result.failedTasks);
}
```

## Wave Grouping

O executor agrupa automaticamente:

```
Wave 1: [A, B]     ← Sem dependências, paralelo
Wave 2: [C]        ← Depende de A e B
Wave 3: [D, E]     ← Dependem de C, paralelo
```

## Configuração

| Opção | Default | Descrição |
|-------|---------|-----------|
| `maxConcurrent` | 5 | Máximo de tasks paralelas |
| `stopOnFirstFailure` | true | Para execução se alguma falhar |

## Exemplo: Skills Refinement

```typescript
const skillTasks: WaveTask[] = [
    // Wave 1 - Paralelo
    { id: 'handoff-skill', name: 'Handoff Skill', execute: createHandoffSkill },
    { id: 'wave-coding-skill', name: 'Wave Coding Skill', execute: createWaveCodingSkill },
    
    // Wave 2 - Depende de Wave 1
    { 
        id: 'update-activation-map', 
        name: 'Update SKILL_ACTIVATION_MAP',
        dependsOn: ['handoff-skill', 'wave-coding-skill'],
        execute: updateActivationMap,
    },
];
```

## Red Flags

❌ **NUNCA:**
- Criar dependências circulares (A→B→A)
- Paralelizar tasks que compartilham estado mutável
- Ignorar `stopOnFirstFailure` para tasks críticas
- Definir `maxConcurrent` muito alto (esgota recursos)

## Integração com ThoughtEvents

O WaveExecutor emite ThoughtEvents:
- `reasoning`: Início de cada wave
- `tool_call`: Início de cada task
- `tool_result`: Conclusão de cada task
- `decision`: Resultado final
