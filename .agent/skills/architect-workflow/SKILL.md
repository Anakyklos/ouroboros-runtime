---
description: Como trabalhar com o Gem Architect (Anti-Vibe Workflow)
---

# Skill: Architect Workflow

Protocolo para colaborar com o Gem "Architect (Anti-Vibe Workflow)" seguindo a metodologia Anti-Vibe.

## Pré-requisitos
- Usar skill `gemini-browser` para automação técnica
- **SEMPRE usar modo Pro**
- URL do Architect: https://gemini.google.com/gem/59819c5e4bfe

## Protocolo Anti-Vibe

O Architect segue um fluxo rigoroso de 3 fases:

### FASE 1: Deep Research (Pesquisa)
**Objetivo:** Entender o problema e gerar diagnóstico

1. Enviar contexto do problema/tarefa
2. Aguardar Architect processar e perguntar
3. Responder perguntas até receber `DIAGNOSTICO_CTX.md`

**Exemplo de mensagem inicial:**
```
Preciso [TAREFA]. Contexto: [DETALHES]. 
Arquivos relevantes: [LISTA]. 
Qual sua análise inicial?
```

### FASE 2: Specification (Especificação)
**Objetivo:** Criar spec técnica antes de codar

1. Após diagnóstico aprovado, pedir: "Prossiga para FASE 2: SPECIFICATION"
2. Aguardar Architect gerar `SPEC_TECNICA.md`
3. Revisar e aprovar ou pedir ajustes

**Transição:**
```
Diagnóstico aprovado. Crie a SPEC_TECNICA.md com: 
arquitetura, interfaces, e plano de verificação.
```

### FASE 3: Execution (Execução)
**Objetivo:** Implementar código seguindo a spec

1. Aprovar spec com: "APROVADO. Prossiga com FASE 3: EXECUTION"
2. Architect gera código
3. Implementar o código gerado
4. Reportar resultados

**Transição:**
```
APROVADO. Gere o código seguindo a spec. 
Inclua todos os arquivos e testes necessários.
```

## Gerenciamento de Contexto

### Quando iniciar novo chat
- Após 10+ mensagens
- Quando contexto ficar confuso
- Após completar uma tarefa grande
- **IMPORTANTE: Quando mudar de assunto/tópico** (evita alucinação)

### Como preservar contexto entre chats
Sempre começar novo chat com resumo:
```
Continuando trabalho no Ouroboros. Estado atual:
- Última tarefa: [RESUMO]
- Arquivos modificados: [LISTA]
- Próximo passo: [OBJETIVO]
```

## Artefatos Esperados

| Fase | Artefato |
|------|----------|
| 1 | DIAGNOSTICO_CTX.md |
| 2 | SPEC_TECNICA.md |
| 3 | Código implementado |

## Dicas

1. **Seja específico**: Architect odeia "vibe coding"
2. **Envie código real**: Não descrições, envie o arquivo
3. **Pergunte antes de fazer**: Especialmente em decisões arquiteturais
4. **Use /clear quando indicado**: Libera tokens para implementação

## Integração GitHub (CRÍTICO)

O GitHub do usuário está conectado ao Gemini. O Architect pode acessar repositórios via opção "Importar código".

### Limitação Importante
> **O Architect só vê o código no momento da importação!**
> 
> Modificações feitas após a importação NÃO são visíveis.
> Você DEVE reimportar o código a cada nova consulta.

### Workflow com GitHub
1. Fazer commit das alterações: `git add . && git commit -m "msg"`
2. Push para GitHub: `git push origin main`
3. No Gemini, clicar em **"+"** → **"Importar código"**
4. Selecionar repositório: `ouroboros-runtime` (ou nome escolhido)
5. Enviar mensagem de consulta

### Antes de cada consulta importante
```bash
# Sempre garantir que o código está atualizado no GitHub
git add .
git commit -m "feat: [descrição]"
git push origin main
```

Depois reimportar no Gemini para o Architect ter a versão mais recente.
