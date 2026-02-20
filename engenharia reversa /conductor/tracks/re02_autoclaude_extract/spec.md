# Track Specification: RE-02 Auto-Claude Prompt and Tool Extraction

## Objetivo
Extrair os prompts do sistema e as definições de ferramentas do repositório `Auto-Claude` para a pasta `_extracted/`, preparando-os para adaptação ao Ouroboros.

## Escopo
- **Origem:**
  - `Auto-Claude/apps/backend/prompts/*.md` (Prompts)
  - `Auto-Claude/apps/backend/agents/tools_pkg/` (Tools)
- **Destino:**
  - `Auto-Claude/_extracted/prompts/`
  - `Auto-Claude/_extracted/tools/`
- **Artefatos:**
  - Arquivos copiados e organizados.
  - `Auto-Claude/_extracted/MANIFEST.md` atualizado.
  - `Auto-Claude/STATUS.md` atualizado para fase `EXTRACT`.

## Fases
1.  **Preparação:** Atualizar status e criar diretórios de destino.
2.  **Extração de Prompts:** Copiar arquivos Markdown de prompts.
3.  **Extração de Tools:** Copiar definições de ferramentas (Python -> Reference).
4.  **Documentação:** Atualizar manifesto e status.

## Critérios de Aceitação
- Todos os arquivos `.md` de `apps/backend/prompts/` copiados para `_extracted/prompts/`.
- Definições de tools copiadas para `_extracted/tools/`.
- `MANIFEST.md` lista todos os arquivos extraídos com seus caminhos originais.
- `STATUS.md` reflete a fase `EXTRACT` ou transição para `ADAPT`.
