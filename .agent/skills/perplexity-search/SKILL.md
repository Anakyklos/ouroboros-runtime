---
description: Pesquisa web profunda usando Perplexity
---

# Skill: Perplexity Deep Search

Usa o Perplexity para pesquisas web profundas quando o Architect não tiver a informação.

## Quando usar
- Architect não sabe responder algo (base de dados limitada)
- Preciso de informações atualizadas da web
- Documentação de bibliotecas/APIs
- Pesquisa de soluções para problemas específicos

## Pré-requisitos
- Browser aberto com Perplexity logado
- URL: https://www.perplexity.ai/

## Pesquisa Profunda (Deep Search)

### Ativar Deep Search
**IMPORTANTE**: Para pesquisa profunda, você DEVE:
1. Clicar no botão **"+"** à esquerda do campo de pesquisa
2. Selecionar o modo **"Deep Research"** ou **"Pro"** 
3. Só depois digitar a query

O modo padrão é pesquisa rápida. Deep Search demora mais mas traz resultados muito mais completos.

### Passos
1. Navegar para https://www.perplexity.ai/
2. Clicar no campo de pesquisa
3. **Clicar no ícone de telescópio** para ativar Deep Search
4. Digitar/injetar a query
5. Aguardar resposta (pode demorar mais que pesquisa normal)

## Injetar Query

```javascript
(() => {
  const msg = "SUA PESQUISA AQUI";
  const input = document.querySelector('textarea[placeholder*="Ask"]') ||
                document.querySelector('textarea');
  if (input) {
    input.value = msg;
    input.dispatchEvent(new Event('input', {bubbles:true}));
    return "OK";
  }
  return "Input não encontrado";
})()
```

## Ler Resposta

```javascript
(() => {
  const response = document.querySelector('.prose') ||
                   document.querySelector('[class*="answer"]');
  return response ? response.innerText : "Resposta não encontrada";
})()
```

## Tempos de Espera
- Pesquisa normal: 10-20 segundos
- **Deep Search**: 30-60 segundos (mais completa)

## Complemento ao Architect
- Architect: raciocínio lógico, arquitetura, specs
- Perplexity: dados atualizados, documentação, APIs externas

Usar Perplexity quando precisar de informações que o Architect (base de dados estática) não consegue fornecer.
