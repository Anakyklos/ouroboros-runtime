---
description: Workflow para dispatch de múltiplos agents em paralelo
---

# Multi-Agent Task Workflow

Workflow para quando há múltiplas tasks independentes que podem ser executadas em paralelo.

## Quando Usar

Use este workflow quando:
- Há 2+ problemas/tasks **verdadeiramente independentes**
- Cada problema tem **domínio claro e separado**
- Resolução de um **não afeta** a resolução de outro

## Decision Tree

```
1. São tasks independentes?
   ├─ NÃO → Use workflow `implementation.md` (sequencial)
   └─ SIM ↓

2. Podem ser decompostas em domínios claros?
   ├─ NÃO → Use workflow `implementation.md` (sequencial)
   └─ SIM ↓

3. Há 2+ problemas?
   ├─ NÃO → Single agent é suficiente
   └─ SIM → ✅ USE PARALLEL DISPATCH
```

## Processo

### Fase 1: Identificar Domínios

1. Listar todas as tasks/problemas
2. Agrupar por domínio (arquivo, módulo, sistema)
3. Verificar independência (mudança em A não quebra B)

**Exemplo:**
```
Task: "Fix login error AND add dark mode"

Domínio 1: Auth (login error)
  - Arquivos: auth/*.ts, login.tsx
  
Domínio 2: UI/Theme (dark mode)  
  - Arquivos: theme/*.ts, components/
  
Independentes? ✅ SIM → Pode parallelizar
```

### Fase 2: Criar Prompts Focados

Para CADA domínio, criar prompt com estrutura:

```markdown
# Task: [One-sentence description]

## Context
- [Background relevante APENAS para este domínio]
- [Arquivos específicos]

## Your Scope
ONLY investigate/modify:
- [Arquivos específicos]
- [Funções específicas]

DO NOT:
- Modificar arquivos fora do escopo
- Fazer mudanças que afetem outros domínios

## Success Criteria
- [Como saber quando terminou]
```

### Fase 3: Dispatch

1. Dispatch todos os agents em paralelo
2. Cada agent trabalha em seu domínio isolado
3. Aguardar todos completarem

### Fase 4: Integração

**CRÍTICO:** Após todos completarem:

1. Verificar conflitos entre mudanças
2. Testar integração (build + tests)
3. Resolver conflitos se houver
4. Review final unificado

// turbo
```bash
# Verificar se não há conflitos
git status
npm run build
npm run test
```

## Red Flags

❌ **NUNCA parallelizar quando:**
- Tasks têm dependências entre si
- Modificam mesmos arquivos
- Uma precisa do resultado da outra
- Domínios não são claros

## Padrões de Multi-Agent

### Supervisor Pattern (mais comum)
```
Orquestrador → [Agent₁, Agent₂, Agent₃] → Agregação → Output
```
- Bom para: Tasks com agregação clara
- Risco: Supervisor bottleneck

### Peer-to-Peer Pattern
```
Agent₁ ←→ Agent₂ ←→ Agent₃
```
- Bom para: Refinamento colaborativo
- Risco: Divergência, overhead de coordenação

## Integração

- **Após parallelização** → Volta para `implementation.md` (review)
- **Se conflitos** → Consultar `multi-agent-patterns` skill
