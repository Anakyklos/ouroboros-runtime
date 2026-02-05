# 🗺️ Skill Activation Map

> Mapeamento automático de situações → skills a consultar

---

## Triggers Automáticos

Sempre que identificar uma das situações abaixo, **DEVO consultar a skill correspondente** antes de agir:

### 🔧 Implementação de Código

| Trigger Keywords | Skill Principal | Ação |
|------------------|-----------------|------|
| "implementar", "criar feature", "develop", "code" | `subagent-development` | Seguir two-stage review |
| "spec", "especificação", "design", "arquitetura" | `architect-workflow` | Fase 1-2-3 Anti-Vibe |
| "testes", "TDD", "test-driven" | `subagent-development` | Implementer + self-review |

**Workflow: Implementação**
```
1. Extrair task description completa
2. Dispatch implementer (fresh context)
3. Self-review pelo implementer
4. Dispatch spec reviewer
5. Se ❌ → fix + re-review
6. Dispatch quality reviewer  
7. Se ❌ → fix + re-review
8. Mark complete
```

---

### 🤖 Multi-Agent / Parallelização

| Trigger Keywords | Skill Principal | Ação |
|------------------|-----------------|------|
| "múltiplas tasks", "parallel", "independentes" | `parallel-dispatching` | Decision tree de parallelização |
| "orquestração", "coordenar agents" | `multi-agent-patterns` | Escolher padrão (supervisor/p2p/hierarchical) |
| "subagent", "delegar" | `autonomous-agent-patterns` | Agent loop + permissions |

**Decision Tree: Parallelizar?**
```
São tasks independentes? 
  ├─ NÃO → Executar sequencialmente
  └─ SIM → Podem ser decompostas em domínios claros?
           ├─ NÃO → Executar sequencialmente  
           └─ SIM → 2+ problemas independentes?
                    ├─ NÃO → Single agent
                    └─ SIM → ✅ DISPATCH PARALLEL
```

---

### 🔌 MCP / Ferramentas

| Trigger Keywords | Skill Principal | Ação |
|------------------|-----------------|------|
| "MCP", "Model Context Protocol", "criar tool" | `mcp-builder` | Best practices de tool design |
| "tool schema", "função para LLM" | `mcp-builder` | Output patterns + descriptions |

**Checklist MCP Builder:**
- [ ] Tool description é task-oriented (não técnica)
- [ ] Parameters têm descriptions claras
- [ ] Output inclui `summary` + `next_steps` quando aplicável
- [ ] Error messages são actionable

---

### 🧠 Context / Memória

| Trigger Keywords | Skill Principal | Ação |
|------------------|-----------------|------|
| "contexto grande", "tokens", "resumir" | `context-window-management` | Tiered context strategy |
| "persistir", "memória", "cross-session" | `memory-systems` | Memory layer architecture |
| "lembrar", "histórico", "entidade" | `memory-systems` | Entity tracking pattern |

**Serial Position Effect:**
```
[INÍCIO: Alta atenção] ➜ [MEIO: Baixa atenção] ➜ [FIM: Alta atenção]

Estratégia: Colocar info crítica no INÍCIO e FIM do prompt
```

---

### 🔒 Segurança / Permissões

| Trigger Keywords | Skill Principal | Ação |
|------------------|-----------------|------|
| "executar comando", "shell", "system" | `autonomous-agent-patterns` | Permission levels |
| "sandbox", "isolado" | `autonomous-agent-patterns` | Sandboxed execution |
| "checkpoint", "resumir sessão" | `autonomous-agent-patterns` | Checkpoint/restore |

**Permission Levels:**
```
AUTO       → Executar sem perguntar (read_file)
ASK_ONCE   → Perguntar uma vez por sessão (write_file)
ASK_EACH   → Perguntar sempre (run_command)
NEVER      → Bloquear totalmente (sudo, delete_system)
```

---

### 🔄 Handoff / Transição

| Trigger Keywords | Skill Principal | Ação |
|------------------|-----------------|------|
| "handoff", "transição", "transferir contexto" | `handoff` | Serializar/deserializar contexto |
| "resumir sessão", "continuar conversa" | `handoff` | Truncar + restaurar |
| "agent A para agent B" | `handoff` | prepareHandoff + rebuildMessages |

---

### 🌊 Wave Coding / Paralelização

| Trigger Keywords | Skill Principal | Ação |
|------------------|-----------------|------|
| "wave coding", "paralelo", "concurrent" | `wave-coding` | Definir tasks + WaveExecutor |
| "múltiplas tasks", "independentes" | `wave-coding` | Decision tree de paralelização |
| "dependências entre tasks" | `wave-coding` | Configurar dependsOn |

**Wave Decision Tree:**
```
2+ tasks independentes?
  ├─ NÃO → Sequencial
  └─ SIM → WAVE CODING
```

---

### 📊 Otimização

| Trigger Keywords | Skill Principal | Ação |
|------------------|-----------------|------|
| "melhorar agent", "performance", "otimizar" | `agent-optimization` | Analysis → Improvement → Test cycle |
| "lento", "latência", "custo" | `agent-optimization` | Context window optimization |

---

### 🛠️ Meta / Skills

| Trigger Keywords | Skill Principal | Ação |
|------------------|-----------------|------|
| "criar skill", "nova skill", "automatizar" | `skill-creator` | 5-phase workflow |

---

## Quick Reference por Categoria

### Core Skills (Sempre Disponíveis)
- `subagent-development` - Implementação com two-stage review
- `multi-agent-patterns` - Arquiteturas de orquestração
- `autonomous-agent-patterns` - Agent loop, permissions, sandbox
- `parallel-dispatching` - Quando e como parallelizar
- `mcp-builder` - Criar tools/MCPs

### Optimization Skills (Quando Necessário)
- `memory-systems` - Persistência cross-session
- `agent-optimization` - Melhorar performance

### Tooling Skills (Meta)
- `skill-creator` - Criar novas skills

### Existing Skills (Projeto Específico)
- `architect-workflow` - Integração com Gemini Architect
- `architect-interaction` - Browser automation para Gemini
- `gemini-browser` - Automação técnica Gemini
- `gemini-chat` - Chat com Gemini
- `perplexity-search` - Pesquisa web atualizada

---

## Regra de Ouro

> **Antes de executar qualquer tarefa complexa:**
> 1. Identificar keywords/situação
> 2. Consultar skill correspondente
> 3. Seguir padrões descritos na skill
> 4. Quando em dúvida, usar `subagent-development` pattern
