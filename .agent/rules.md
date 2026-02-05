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
| **OpenCode** | Execução de código | Subagentes para implementação |

### Regras
- Architect = cérebro estratégico (pensamento)
- Perplexity = memória atualizada (dados)
- OpenCode = braços executores (ação)
- Posso criar **novos Gems** se necessário para funções específicas

## Memória
- Documentar decisões importantes em `.agent/memory/`
- Manter specs e planos atualizados
- Criar walkthroughs para tarefas complexas
