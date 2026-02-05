---
description: Workflow completo com Architect + spec review integrado
---

# Architect Specification Workflow

Workflow que combina o Gemini Architect (Anti-Vibe) com os padrões de spec review das skills.

## Quando Usar

- Novas features complexas que precisam de design
- Decisões arquiteturais significativas
- Qualquer coisa que afete mais de 3 arquivos
- Quando não está claro COMO implementar

## Processo Completo

### Fase 1: Deep Research (Architect)

**Skill:** `architect-workflow` + `architect-interaction`

1. Abrir Gemini Architect no modo Pro
2. Enviar contexto do problema:
   ```
   Preciso [TAREFA]. Contexto: [DETALHES].
   Arquivos relevantes: [LISTA].
   Qual sua análise inicial?
   ```
3. Responder perguntas do Architect
4. Receber `DIAGNOSTICO_CTX.md`

### Fase 2: Specification (Architect)

1. Aprovar diagnóstico: "Prossiga para FASE 2: SPECIFICATION"
2. Aguardar `SPEC_TECNICA.md`
3. **CRÍTICO:** Revisar spec antes de aprovar

**Checklist de Spec Review:**
- [ ] Cobre todos os requisitos?
- [ ] Interfaces estão claras?
- [ ] Plano de verificação existe?
- [ ] Não há over-engineering?

### Fase 3: Execution (Subagent Development)

Após spec aprovada, usar `implementation.md` workflow:

1. Extrair tasks da spec
2. Para cada task:
   - Dispatch implementer
   - Spec review
   - Quality review
3. Commit após cada task completa

### Fase 4: Verification

Voltar ao Architect para verificação:

1. Push código para GitHub
2. Reimportar código no Gemini
3. Pedir review: "Verifique se a implementação segue a spec"
4. Ajustar se necessário

## Integração de Skills

```
┌─────────────────────────────────────────────────────────┐
│                    ARCHITECT FLOW                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [Architect Workflow]                                   │
│       │                                                 │
│       ▼                                                 │
│  Deep Research → Spec → ─────────────────────┐          │
│                                              │          │
│  [Subagent Development]                      │          │
│       │                                      │          │
│       ▼                                      │          │
│  Implementer → Spec Review → Quality Review  │          │
│       │                                      │          │
│       ▼                                      │          │
│  [Architect Verification] ◄──────────────────┘          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Gerenciamento de Contexto

**Skill:** `memory-systems`, `context-window-management`

### Quando iniciar novo chat no Gemini
- Após 10+ mensagens
- Ao mudar de assunto/tópico
- Quando contexto ficar confuso
- Após completar feature grande

### Como preservar contexto
```
Continuando trabalho no Ouroboros. Estado atual:
- Última spec: [NOME_SPEC]
- Tasks implementadas: [X/Y]
- Próximo passo: [OBJETIVO]
```

## Artefatos Gerados

| Fase | Origem | Artefato |
|------|--------|----------|
| 1 | Architect | DIAGNOSTICO_CTX.md |
| 2 | Architect | SPEC_TECNICA.md |
| 3 | Implementer | Código + Tests |
| 4 | Architect | Validation Report |

## Red Flags

❌ **NUNCA:**
- Pular Architect para features complexas
- Implementar sem spec aprovada
- Esquecer de reimportar código no Gemini
- Usar Flash/Rápido (sempre Pro)
