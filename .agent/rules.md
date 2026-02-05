# Ouroboros Workspace Rules

## Autonomia Sandbox (Opção A)
O Antigravity tem controle **irrestrito** dentro deste repositório e `.ouroboros/`, mas NÃO pode mexer fora disso.

### Permitido ✅
- Editar qualquer arquivo em `/Ouroboros`
- Criar/deletar dentro de `.ouroboros/`
- Executar Python/scripts no venv isolado
- Git commit/push neste repositório
- Criar e modificar skills

### Proibido ❌
- Deletar arquivos do sistema
- Acessar outros repositórios
- Instalar pacotes globalmente
- Modificar configurações do sistema

---

## Skills
O Antigravity deve criar skills para automatizar tarefas repetitivas.

### Onde criar skills
Skills devem ser criadas em `.agent/skills/` dentro deste repositório.

### Estrutura de uma skill
```
.agent/skills/[skill-name]/
├── SKILL.md          # Instruções principais (obrigatório)
├── scripts/          # Scripts auxiliares
├── examples/         # Exemplos de uso
└── resources/        # Recursos adicionais
```

### Quando criar uma skill
- Quando uma tarefa precisa ser feita mais de 2 vezes
- Quando um padrão de automação é identificado
- Quando o Architect sugere um fluxo específico

---

## Integração Gemini
Para comunicar com o Architect:
1. **SEMPRE mudar para modo Pro** (não usar Flash/Rápido)
2. Usar JavaScript injection (não digitar caractere por caractere)
3. Extrair respostas via `document.querySelectorAll('message-content')`
4. Iniciar novo chat quando contexto ficar muito grande
5. **Novo chat ao mudar de assunto** (evita alucinação)

---

## Hierarquia de Ferramentas de IA

| Ferramenta | Força | Uso |
|------------|-------|-----|
| **Gemini Architect** | Raciocínio profundo, arquitetura | Specs, design, revisão de código |
| **Perplexity** | Informações atualizadas da web | APIs, docs, pesquisa de soluções |
| **Z.AI DirectAPI** | Execução de código | Subagentes para implementação |

### Regras
- Architect = cérebro estratégico (pensamento)
- Perplexity = memória atualizada (dados)
- Z.AI = braços executores (ação via AgentLoop)
- Posso criar **novos Gems** se necessário para funções específicas

## Memória
- Documentar decisões importantes em `.agent/memory/`
- Manter specs e planos atualizados
- Criar walkthroughs para tarefas complexas

---

## Skill Activation Protocol 🧠

### Regra de Ouro
> **Antes de executar qualquer tarefa complexa:**
> 1. Identificar keywords/situação
> 2. Consultar skill correspondente em `.agent/skills/`
> 3. Seguir padrões descritos na skill
> 4. Usar workflows em `.agent/workflows/`

### Mapeamento Automático de Skills

| Situação | Skill/Workflow | Ação |
|----------|----------------|------|
| Implementar código | `/implementation` | Two-stage review |
| Múltiplas tasks independentes | `/multi-agent-task` | Parallel dispatch |
| Feature complexa | `/architect-spec` | Architect + subagent |
| Criar MCP/tool | `core/mcp-builder` | Tool design patterns |
| Context grande (>50k tokens) | `optimization/memory-systems` | Memory layers |

### Triggers por Keyword

- **"implementar", "criar", "develop"** → Workflow `/implementation`
- **"paralelo", "independentes", "múltiplas"** → Workflow `/multi-agent-task`  
- **"arquitetura", "design", "spec"** → Workflow `/architect-spec`
- **"MCP", "tool", "function"** → Skill `mcp-builder`
- **"otimizar", "performance"** → Skill `agent-optimization`

### Referência Completa
Ver: [SKILL_ACTIVATION_MAP.md](.agent/skills/SKILL_ACTIVATION_MAP.md)

---

## Workflows Disponíveis

| Comando | Workflow | Uso |
|---------|----------|-----|
| `/implementation` | [implementation.md](.agent/workflows/implementation.md) | Implementação padrão |
| `/multi-agent-task` | [multi-agent-task.md](.agent/workflows/multi-agent-task.md) | Tasks paralelas |
| `/architect-spec` | [architect-spec.md](.agent/workflows/architect-spec.md) | Architect + review |

### Prompts Templates
- `.agent/prompts/implementer.md` - Dispatch implementação
- `.agent/prompts/spec-reviewer.md` - Review de spec  
- `.agent/prompts/code-quality-reviewer.md` - Review de qualidade

---

## Skills Disponíveis

### Core (Sempre Consultar)
- `core/subagent-development` - Implementação com two-stage review
- `core/multi-agent-patterns` - Arquiteturas de orquestração
- `core/autonomous-agent-patterns` - Agent loop, permissions
- `core/parallel-dispatching` - Quando parallelizar
- `core/mcp-builder` - Criar MCPs/tools

### Optimization
- `optimization/memory-systems` - Persistência cross-session
- `optimization/agent-optimization` - Performance tuning

### Existing
- `architect-workflow` - Gem Architect Anti-Vibe
- `gemini-browser` / `gemini-chat` - Automação Gemini
- `perplexity-search` - Pesquisa web

