---
description: Workflow principal de implementação usando subagent-development pattern
---

# Implementation Workflow

Workflow para implementar features seguindo o padrão `subagent-development`.

## Quando Usar

- Implementação de qualquer feature nova
- Modificações significativas em código existente
- Refatorações que afetam múltiplos arquivos

## Pré-requisitos

1. Task description clara (do Architect ou do usuário)
2. Arquivos de contexto identificados
3. Critérios de aceitação definidos

## Processo

### Fase 1: Preparação
// turbo
```bash
# Garantir branch limpo
git status
```

1. Extrair task description completa do plano/spec
2. Identificar arquivos que serão modificados
3. Preparar contexto (imports, dependências, padrões existentes)

### Fase 2: Implementação (Implementer Role)

Seguir template de `.agent/prompts/implementer.md`:

1. Ler task description completamente
2. **Perguntar ANTES de começar** se algo não estiver claro
3. Implementar exatamente o especificado
4. Escrever testes (TDD se aplicável)
5. Auto-review antes de reportar

### Fase 3: Spec Review

Após implementação, verificar spec compliance:

**Checklist:**
- [ ] Implementou TUDO que foi pedido?
- [ ] Implementou APENAS o que foi pedido (não over-engineer)?
- [ ] Código corresponde à especificação linha por linha?

**Se encontrar issues:**
1. Documentar especificamente o que está faltando/sobrando
2. Corrigir
3. Re-verificar

### Fase 4: Quality Review

Após spec compliance, verificar qualidade:

**Checklist (baseado em user_rules):**
- [ ] DRY - Não há duplicação?
- [ ] KISS - Código é simples e legível?
- [ ] YAGNI - Não construiu coisas desnecessárias?
- [ ] Separation of Concerns - Lógica separada de UI?
- [ ] Error Handling - Erros tratados gracefully?
- [ ] Naming - Nomes descritivos e claros?

**Se encontrar issues:**
1. Documentar com file:line references
2. Corrigir
3. Re-verificar

### Fase 5: Commit

// turbo
```bash
git add .
git commit -m "feat: [descrição concisa]"
```

## Red Flags

❌ **NUNCA:**
- Pular reviews (spec OU quality)
- Continuar com issues não resolvidos
- Implementar paralelo sem usar `parallel-dispatching` skill
- Fazer subagent ler arquivos de plano (passar texto completo)
- Assumir ao invés de perguntar

## Integração com Outras Skills

- **Se task complexa** → Consultar `architect-workflow` primeiro
- **Se múltiplas tasks independentes** → Usar `wave-coding` (substituiu parallel-dispatching)
- **Se transição entre agents** → Usar `handoff` para contexto
- **Se criar MCP/tool** → Usar `mcp-builder`

## Wave Coding Mode

Se a implementação envolve 2+ tasks independentes, considere usar Wave Coding:

```typescript
const tasks: WaveTask[] = [
    { id: 'task-a', execute: implA },
    { id: 'task-b', execute: implB },
    { id: 'integration', dependsOn: ['task-a', 'task-b'], execute: integrate },
];
await executor.execute(tasks);
```

Ver skill `wave-coding` para detalhes.
