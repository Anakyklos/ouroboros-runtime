# Implementer Prompt - Ouroboros

Template para dispatch de implementação. Copiar e preencher.

---

```markdown
# Task: [Nome da Task]

## Task Description

[COLAR TEXTO COMPLETO DA TASK/SPEC AQUI - não fazer subagent ler arquivo]

## Context

**Projeto:** Ouroboros (TypeScript + Python)
**Stack:** Bun, TypeScript, Python venv isolado
**Padrões:** DRY, KISS, YAGNI, Separation of Concerns

**Arquivos Relevantes:**
- [arquivo1.ts] - [propósito]
- [arquivo2.ts] - [propósito]

**Dependências:**
- [O que precisa estar funcionando antes]

## Antes de Começar

Se algo não estiver claro sobre:
- Requisitos ou critérios de aceitação
- Abordagem ou estratégia de implementação
- Dependências ou suposições
- Qualquer parte da task description

**PERGUNTE AGORA.** Não assuma, não adivinhe.

## Seu Trabalho

Quando estiver claro sobre os requisitos:

1. **Implementar exatamente** o que a task especifica
2. **Escrever testes** (TDD se indicado)
3. **Verificar** que a implementação funciona
4. **Commit** seu trabalho
5. **Auto-review** (ver abaixo)
6. **Reportar** resultado

**Diretório de trabalho:** c:\Users\pedro\Documents\Ouroboros

**Enquanto trabalha:** Se encontrar algo inesperado ou unclear, PERGUNTE.
Sempre OK pausar e clarificar. Não adivinhe.

## Auto-Review Obrigatório

Antes de reportar, revisar seu trabalho:

**Completude:**
- [ ] Implementei TUDO que está na spec?
- [ ] Perdi algum requisito?
- [ ] Há edge cases não tratados?

**Qualidade (User Rules):**
- [ ] DRY: Não há duplicação de código?
- [ ] KISS: Código é simples e legível?
- [ ] YAGNI: Só construí o que foi pedido?
- [ ] Separation of Concerns: Lógica separada de UI?
- [ ] Error Handling: Erros tratados gracefully?

**Disciplina:**
- [ ] Segui padrões existentes no codebase?
- [ ] Nomes são claros e descritivos?
- [ ] Código está bem formatado?

**Se encontrar issues durante auto-review, CORRIJA antes de reportar.**

## Formato do Report

Quando terminar:

```
## Implementação
- O que implementei

## Testes  
- Testes criados
- Resultados: X/Y passando

## Arquivos Modificados
- arquivo1.ts (modificado)
- arquivo2.ts (criado)

## Auto-Review
- Issues encontrados e corrigidos: [lista]
- Issues pendentes: [lista, se houver]

## Concerns
- [Qualquer preocupação ou dúvida]
```
```

---

## Notas de Uso

1. Sempre preencher `[placeholders]` antes de usar
2. Task description deve ser COMPLETA, não referência a arquivo
3. Incluir contexto suficiente para trabalho independente
4. Listar arquivos relevantes com seus propósitos
