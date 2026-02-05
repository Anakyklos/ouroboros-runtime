---
name: Browser MCP Troubleshooting
description: Como diagnosticar e resolver problemas de timeout no browser MCP
---

# Browser MCP Troubleshooting

Guia para resolver problemas comuns do browser MCP, especialmente timeouts.

## Problema Comum: WebSocket Timeout (30s)

### Sintoma
```
Error: WebSocket response timeout after 30000ms
```

### Causas
1. **Páginas pesadas** - Sites como Gemini, ChatGPT usam muito JavaScript
2. **Operações lentas** - Clicks em elementos que trigam re-renders complexos
3. **Resposta lenta do servidor** - Latência de rede ou servidor sobrecarregado
4. **Muitas chamadas paralelas** - Sobrecarrega a conexão WebSocket

---

## Soluções por Prioridade

### 1. Verificar Conexão (Primeiro Passo)
Se `navigate` funciona mas `click` falha, a conexão está OK. O problema é a página.

### 2. Usar `wait` Entre Operações
```typescript
// Esperar página estabilizar antes de interagir
mcp_browsermcp_browser_wait({ time: 3 })
mcp_browsermcp_browser_snapshot()
```

### 3. Verificar Estado Após Timeout
Timeouts não significam falha! A operação pode ter completado.
```typescript
// Click deu timeout, mas verificar se funcionou
mcp_browsermcp_browser_snapshot()
// Se o estado mudou, o click funcionou
```

### 4. Usar Snapshot ao invés de Screenshot
Snapshots são mais leves que screenshots. Prefira:
```typescript
// ✅ Mais leve
mcp_browsermcp_browser_snapshot()

// ❌ Mais pesado
mcp_browsermcp_browser_screenshot()
```

### 5. Evitar Páginas Problemáticas
Algumas páginas são conhecidamente problemáticas:
- ❌ gemini.google.com (muito JavaScript)
- ❌ chat.openai.com (muitos re-renders)
- ✅ Páginas estáticas
- ✅ Documentação simples

---

## Alternativas Quando Browser MCP Falha

### Para Pesquisa
Use `search_web` ao invés de navegar:
```typescript
search_web({ query: "OpenClaw architecture patterns" })
```

### Para APIs
Use `read_url_content` para conteúdo estático:
```typescript
read_url_content({ url: "https://docs.example.com/api" })
```

### Para Interações Complexas
Considere:
1. Pedir ao usuário para fazer manualmente
2. Usar a API direta do serviço (se disponível)
3. Documentar a limitação e propor workaround

---

## Diagnóstico Rápido

| Operação | Funciona? | Diagnóstico |
|----------|-----------|-------------|
| `navigate` | ✅ | Conexão OK |
| `navigate` | ❌ | MCP não conectado - pedir ao usuário conectar |
| `snapshot` | ✅ | Página leve |
| `snapshot` | ❌ | Página muito pesada |
| `click` | ✅ | Elemento responsivo |
| `click` | ❌ (timeout) | JavaScript pesado ou elemento falsy |

---

## Configuração Recomendada

> [!TIP]
> Não há como aumentar o timeout do browser MCP diretamente.
> A solução é trabalhar com operações mais simples.

## Red Flags

❌ **NUNCA:**
- Fazer múltiplos clicks sem verificar estado
- Assumir que timeout = falha
- Tentar forçar páginas pesadas repetidamente
- Ignorar a limitação e continuar tentando

✅ **SEMPRE:**
- Verificar snapshot após timeout
- Usar wait entre operações
- Ter plano B (search_web, API, manual)
- Documentar limitações encontradas
