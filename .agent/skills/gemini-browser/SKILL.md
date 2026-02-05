---
description: Automação geral do Gemini via browser
---

# Skill: Gemini Browser

Automatiza interações com o Gemini via browser usando JavaScript injection.

## Pré-requisitos
- Browser aberto com Gemini logado
- Pode ser qualquer conversa ou Gem

## Mudar para Modo Pro (OBRIGATÓRIO)

### Via click
1. Localizar o seletor de modelo (mostra "Rápido" ou "Pro")
2. Clicar para abrir dropdown
3. Selecionar "Pro"

### Verificar modo atual
```javascript
(() => {
  const modelBtn = document.querySelector('[data-test-id="model-selector"]');
  return modelBtn ? modelBtn.innerText : "Seletor não encontrado";
})()
```

## Injetar Mensagem

```javascript
(() => {
  const msg = "SUA MENSAGEM AQUI";
  const input = document.querySelector('[contenteditable="true"]') || 
                document.querySelector('.ql-editor');
  if (input) {
    // Usar para contenteditable
    if (input.classList.contains('ql-editor')) {
      let p = input.querySelector('p');
      if (!p) { p = document.createElement('p'); input.appendChild(p); }
      p.textContent = msg;
      input.classList.remove('ql-blank');
    } else {
      input.innerText = msg;
    }
    input.dispatchEvent(new Event('input', {bubbles:true}));
    return "OK";
  }
  return "Input não encontrado";
})()
```

## Clicar Botão Enviar

Após injetar, clicar no botão de enviar:
- Coordenadas aproximadas: X:826, Y:883
- Ou via JS:
```javascript
document.querySelector('button[aria-label="Enviar mensagem"]')?.click()
```

## Ler Última Resposta

```javascript
(() => {
  const responses = document.querySelectorAll('message-content');
  if (responses.length > 0) {
    return responses[responses.length - 1].innerText;
  }
  return "Nenhuma resposta encontrada";
})()
```

## Extrair Blocos de Código

```javascript
(() => {
  const codes = document.querySelectorAll('pre code, code-block');
  return Array.from(codes).map((c, i) => 
    `=== BLOCO ${i+1} ===\n${c.innerText}`
  ).join('\n\n');
})()
```

## Scroll para Ver Resposta Completa

```javascript
(() => {
  const chat = document.querySelector('.chat-history') || 
               document.querySelector('infinite-scroller');
  if (chat) { chat.scrollTop = chat.scrollHeight; }
  return "Scrolled";
})()
```

## Tempos de Espera
- Modo Pro: 30-60 segundos
- Modo Flash/Rápido: 10-20 segundos
