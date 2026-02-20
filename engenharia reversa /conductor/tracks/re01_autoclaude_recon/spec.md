# Track Specification: RE-01 Auto-Claude Reconnaissance and Dissection

## Objetivo
Executar as fases iniciais do protocolo de engenharia reversa no repositório `Auto-Claude`:
1.  **Inicialização:** Criar `ANALYSIS.md`, `STATUS.md` e atualizar o `CATALOG.md`.
2.  **RECON (Reconhecimento):** Mapear estrutura de diretórios, stack tecnológica e entrypoints.
3.  **DISSECT (Dissecação):** Analisar fluxo de dados, abstrações centrais e identificar módulos críticos ("diamantes").
4.  **Documentação:** Preencher o `ANALYSIS.md` com os achados.

## Escopo
- **Diretório Alvo:** `/home/pedro/Projetos de I.A./ouroboros-runtime/engenharia reversa/Auto-Claude`
- **Artefatos Gerados:**
  - `Auto-Claude/ANALYSIS.md` (com seções RECON e DISSECT preenchidas)
  - `Auto-Claude/STATUS.md` (atualizado para fase DISSECT)
  - `Auto-Claude/_extracted/MANIFEST.md` (lista inicial de extrações)
  - `CATALOG.md` (entrada atualizada)

## Fases
1.  **Reconhecimento:** Análise superficial (estrutura, dependências, tech stack).
2.  **Dissecação:** Análise profunda (fluxo de dados, abstrações, módulos críticos).

## Critérios de Aceitação
- `ANALYSIS.md` preenchido com:
  - Tech Stack completa (linguagens, frameworks, banco de dados).
  - Estrutura de diretórios mapeada.
  - Entrypoints identificados.
  - Fluxo de dados principal diagramado (descrição textual ou Mermaid).
  - Módulos críticos listados.
- `STATUS.md` reflete a fase atual como `DISSECT` ou `EXTRACT` (pendente).
- `CATALOG.md` contém a entrada para `Auto-Claude`.
