---
name: Handoff Protocol
description: Como transferir contexto entre agentes ou sessões usando HandoffManager
---

# Handoff Protocol

Skill para transição de contexto entre agentes ou sessões.

## Quando Usar

- Transição entre agentes especializados (spec → exec)
- Resumo de sessão para continuidade
- Checkpoint antes de operações longas
- Truncagem de contexto quando limite de tokens é atingido

## Módulo Principal

`cli/src/daemon/handoff.ts` - `HandoffManager`

## API

### Preparar Handoff

```typescript
import { createHandoffManager } from '../daemon/handoff.js';

const manager = createHandoffManager();

const context = manager.prepareHandoff({
    sessionId: 'session_123',
    conversationHistory: messages, // Array de Message
    systemPrompt: 'You are...',
    workingDirectory: '/path/to/project',
    reason: 'Transitioning to execution phase',
});
```

### Serializar para JSON

```typescript
const json = manager.serializeContext(context);
// Salvar em arquivo ou transmitir para outro agent
```

### Restaurar Contexto

```typescript
const result = manager.deserializeContext(json);
if (result.success) {
    const messages = manager.rebuildMessages(result.context);
    // Continuar conversa com messages
}
```

### Truncar para Limite de Tokens

```typescript
const truncated = manager.truncateContext(context, 4000);
// Remove mensagens antigas mantendo primeira e última
```

## Padrão de Uso

```
┌─────────────┐    prepareHandoff    ┌─────────────┐
│   Agent A   │ ──────────────────► │   Handoff   │
│   (Spec)    │                      │   Context   │
└─────────────┘                      └─────────────┘
                                           │
                                           │ serialize + transfer
                                           ▼
┌─────────────┐    deserialize       ┌─────────────┐
│   Agent B   │ ◄────────────────── │   Handoff   │
│   (Exec)    │    rebuildMessages   │   Context   │
└─────────────┘                      └─────────────┘
```

## Campos do HandoffContext

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `sessionId` | string | ID da sessão original |
| `conversationHistory` | Message[] | Histórico (sem system prompt) |
| `systemPrompt` | string | System prompt a usar |
| `workingDirectory` | string | Diretório de trabalho |
| `pendingToolCalls` | ToolCall[]? | Tool calls não executados |
| `metadata` | Record? | Dados customizados |
| `createdAt` | Date | Timestamp |
| `reason` | string? | Motivo do handoff |

## Red Flags

❌ **NUNCA:**
- Transferir sem serializar (objetos não são portáteis)
- Ignorar limites de tokens (causa truncagem inesperada)
- Incluir dados sensíveis no metadata
- Assumir que pendingToolCalls sempre existe
