# Ouroboros Workspace Rules

> **Status**: Alinhado à direção #60 (executive coordination).
> Para arquitetura: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).
> Para classificação de legado: [docs/LEGACY_MATRIX.md](../docs/LEGACY_MATRIX.md).

---

## Identidade

Ouroboros é o **executive runtime / sistema nervoso do Anakyklos**. Planning/LLM
é advisory; código/policy autoriza effects. `MissionIntent != Mission`.

**Proibido como direção de trabalho neste repositório:**
- Self-modification do core (`modifySelf()`, promoção silenciosa do próprio
  código) — proibido por #69
- Council/personas como arquitetura central — legado classificado
- Execução irrestrita de Python/shell — legado classificado
- Banco universal de memória / dono de databases de outros módulos
- Ampliar bridges diretas (Antigravity/Gemini/Jules) como API central
- Ampliar waves, Ralph, MCP/skills, TUI React/Ink, Electron como direção

**Válido:**
- Self-improving Anakyklos governado (#69): observar → bounded adaptation OR
  CapabilityGap → Cadinho trial → Runstead implementation → verification →
  promoção explícita
- Mission durável (#62), Capability Registry (#63), Context Compiler (#64),
  policy determinística, topologia #70 (headless + Mission Control + CLI)

---

## Permissões do agente

O agente trabalha dentro deste repositório. Pode:
- Editar arquivos do repositório conforme a issue em andamento
- Criar/deletar arquivos dentro do repositório (exceto áreas classificadas
  RETIRE sem decisão de remoção aprovada)
- Git commit/push neste repositório conforme workflow
- Executar comandos de build/teste/verificação

Não pode:
- Acessar bancos privados de outros módulos (Katherine, Runstead, Cadinho,
  LifeOS, Tecer, device modules)
- Instalar pacotes globalmente sem necessidade
- Modificar configurações do sistema
- Alterar/promover o próprio código em produção silenciosamente
- Modificar outros módulos do Anakyklos

---

## Skills

- Skills de projeto ficam em `.agent/skills/` (local ao repositório).
- **Não** usar skills de self-modification, agent forging, Council/personas ou
  expansão MCP como autoridade arquitetural.
- Graph Mode pertence ao mantenedor, não ao executor.

---

## Baseline e validação

```bash
bun install --frozen-lockfile
cd web && bun install --frozen-lockfile && cd ..
bun run check
git diff --check
```

- Proibido: `skip`, `todo`, `only`, `|| true`, `continue-on-error`, remoção de
  testes, assertions enfraquecidas.
- Suites em quarentena: `scripts/quarantine-manifest.json` (#41).

---

## Configuração do agente (JCode etc.)

Qualquer configuração específica do projeto (JCode, Spec Kit, skills) deve
permanecer **local ao repositório** (ex.: `.jcode/`, `.specify/`). Não instalar
configuração do projeto em `~/.jcode`.
