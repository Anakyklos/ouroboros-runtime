---
description: Como comunicar com o Gemini Architect via browser
---

# Skill: Gemini Chat

Automatiza a comunicação com o Gem "Architect (Anti-Vibe Workflow)" no Gemini.

## Pré-requisitos
- Browser aberto com Gemini logado
- Gem Architect selecionado (URL: https://gemini.google.com/gem/59819c5e4bfe)

## Enviar Mensagem

### 1. Injetar texto via JavaScript (SEMPRE usar isso, nunca digitar)
```javascript
(() => {
  const msg = "SUA MENSAGEM AQUI";
  const input = document.querySelector('[contenteditable="true"]');
  if (input) {
    input.innerText = msg;
    input.dispatchEvent(new Event('input', {bubbles:true}));
    return "OK";
  }
  return "Input não encontrado";
})()
```

### 2. Clicar no botão enviar
Coordenadas aproximadas: X:826, Y:883

### 3. Aguardar resposta
- Modo Pro: aguardar 30-60 segundos
- Modo Flash: aguardar 10-20 segundos

## Ler Resposta

### Extrair texto completo
```javascript
(() => {
  const responses = document.querySelectorAll('message-content');
  if (responses.length > 0) {
    return responses[responses.length - 1].innerText;
  }
  return "Resposta não encontrada";
})()
```

### Extrair blocos de código
```javascript
(() => {
  const codes = document.querySelectorAll('pre code, code-block');
  return Array.from(codes).map((c, i) => 
    `=== BLOCO ${i+1} ===\n${c.innerText}`
  ).join('\n\n');
})()
```

## Iniciar Novo Chat
Navegar para: https://gemini.google.com/gem/59819c5e4bfe (sem ID de conversa)

## Trocar Modelo
1. Clicar no seletor de modelo (canto inferior direito)
2. Selecionar "Pro" ou "Flash/Rápido"
