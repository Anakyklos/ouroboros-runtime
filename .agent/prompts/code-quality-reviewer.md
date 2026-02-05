# Code Quality Reviewer Prompt - Ouroboros

Template para review de qualidade de código baseado nas User Rules.

---

```markdown
# Quality Review: [Nome da Task]

## Contexto
- **Arquivos modificados:** [lista]  
- **Git commits:** [SHAs se disponíveis]
- **Spec compliance já verificada:** ✅

## User Rules Reference

O código DEVE seguir estas regras do projeto:

### DRY (Don't Repeat Yourself)
- Não há magic values hardcoded?
- Lógica duplicada foi abstraída?
- Types/interfaces centralizados?

### KISS (Keep It Simple)
- Código é legível e explícito?
- Usa métodos nativos/bibliotecas existentes?
- Evita nesting profundo (early returns)?
- Nomes são descritivos?

### YAGNI (You Aren't Gonna Need It)
- Implementou APENAS o necessário?
- Não há future-proofing desnecessário?
- Código morto foi removido?

### Separation of Concerns
- Lógica de negócio separada de UI?
- Config separada de código?
- Arquivos < 200 linhas?

### Error Handling
- Erros são tipados corretamente?
- Mensagens de erro são user-friendly?
- Fail loud em dev, graceful em prod?

## Seu Trabalho

Revisar o código com foco em QUALIDADE (não spec compliance):

### Checklist

**DRY:**
- [ ] Nenhuma duplicação de código
- [ ] Constantes extraídas
- [ ] Utility functions para lógica comum

**KISS:**
- [ ] Nenhum nesting > 3 níveis
- [ ] Nenhuma one-liner "clever" confusa
- [ ] Nomes claros e descritivos

**YAGNI:**
- [ ] Nada construído "para o futuro"
- [ ] Nenhum código comentado
- [ ] API mínima exposta

**Separation:**
- [ ] Hooks para lógica complexa
- [ ] Componentes focados
- [ ] Config isolada

**Errors:**
- [ ] Try/catch apropriado
- [ ] Mensagens actionable
- [ ] Tipos de erro corretos

## Formato do Report

```
# Quality Review Result

## Verdict: ✅ APPROVED / ⚠️ MINOR ISSUES / ❌ REJECTED

### Strengths
- [O que está bem feito]

### Issues

#### Critical (bloqueia aprovação)
- [Problema] em [arquivo:linha] - [por que é problema]

#### Important (deve corrigir)
- [Problema] em [arquivo:linha] - [sugestão de fix]

#### Minor (nice to have)
- [Problema] em [arquivo:linha] - [sugestão]

### Recommendations
- [Sugestões de melhoria para futuro]
```
```

---

## Critérios de Aprovação

**✅ APPROVED:**
- Nenhum issue Critical ou Important
- Código segue user rules

**⚠️ MINOR ISSUES:**
- Apenas issues Minor
- Pode aprovar com ressalvas

**❌ REJECTED:**
- Qualquer issue Critical OU
- Múltiplos issues Important
- Violação clara de user rules
