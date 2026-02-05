---
name: consult-architect
description: Como consultar o Architect (Gemini) para design review e aprovação de specs
---

# Skill: Consult Architect

## Quando Usar
Use esta skill quando precisar de:
- **Design review** antes de implementar features complexas
- **Spec approval** para validar arquitetura
- **Pattern guidance** sobre melhores práticas
- **Risk assessment** para mudanças críticas

## Infraestrutura

### Gemini Bridge
- **Localização**: `c:\Users\pedro\Documents\Ouroboros\gemini-bridge\`
- **Comando**: `python -m src` (MCP server)
- **Tools disponíveis**:
  - `consult_gemini(query, directory, model)`
  - `consult_gemini_with_files(query, directory, files, model)`

### Modelos
| Modelo | Uso | Custo |
|--------|-----|-------|
| `flash` | Queries rápidas, design simples | Mais rápido |
| `pro` | Análise profunda, specs complexas | Mais lento |

## Fluxo de Uso (Anti-Vibe Protocol)

### 1️⃣ FASE 1: DEEP RESEARCH (Investigação)
**Objetivo:** Obter aprovação do Diagnóstico.
**Entregável:** `DIAGNOSTICO_CTX.md`

```python
# Passo 1: Solicitar Deep Research / Diagnóstico
consult_gemini(
    query="Inicie a Fase 1 (Deep Research) para a feature [NOME]. Contexto: [DESCRIÇÃO]. Gere o DIAGNOSTICO_CTX.md.",
    directory="c:\\Users\\pedro\\Documents\\Ouroboros",
    model="flash"
)
```

### 2️⃣ FASE 2: SPECIFICATION (Planejamento)
**Objetivo:** Obter aprovação da Spec Técnica.
**Entregável:** `SPEC_TECNICA.md`
**Input:** `DIAGNOSTICO_CTX.md` (aprovado)

```python
# Passo 2: Solicitar Spec Técnica baseada no Diagnóstico
consult_gemini_with_files(
    query="Diagnóstico aprovado. Inicie a Fase 2 (Specification). Gere o SPEC_TECNICA.md detalhando a arquitetura e tasks.",
    directory="c:\\Users\\pedro\\Documents\\Ouroboros",
    files=["DIAGNOSTICO_CTX.md"],
    model="pro"
)
```

### 3️⃣ FASE 3: EXECUTION (Mão na Massa)
**Objetivo:** Implementar seguindo a Spec cegamente.
**Input:** `SPEC_TECNICA.md` (aprovado)

```python
# Passo 3: Execução baseada na Spec
consult_gemini_with_files(
    query="Spec aprovada. Inicie a Fase 3 (Execution). Implemente os passos descritos na Spec.",
    directory="c:\\Users\\pedro\\Documents\\Ouroboros",
    files=["SPEC_TECNICA.md"],
    model="flash" # ou pro para tasks complexas
)
```

## Integração com Orchestrator

| Fase Orchestrator | Ação Architect | Artefato Gerado |
|-------------------|----------------|-----------------|
| **PLANNING** | Fase 1 & 2 | `DIAGNOSTICO_CTX.md`, `SPEC_TECNICA.md` |
| **EXECUTION** | Fase 3 | (Código e Smoke Test) |
| **VERIFICATION** | Validação Final | (Relatório de Validação) |

## Limitações

- **Timeout**: Default 60s, configurável até 300s
- **File size**: Max ~256KB per file inline
- **Rate limiting**: Depende do Gemini CLI auth

## Troubleshooting

### "CLI not available"
```bash
npm install -g @google/gemini-cli
gemini auth login
```

### "Authentication required"
```bash
gemini auth login
```

### Timeout
Aumente `timeout_seconds` ou use `mode="at_command"` para arquivos grandes.
