# Diretrizes do Produto: Ouroboros (Engenharia Reversa do Auto Claude)

Estas diretrizes estabelecem os padrões de qualidade, estilo e processo para a engenharia reversa do Auto Claude e sua adaptação ao ecossistema Ouroboros.

## Filosofia do Projeto
- **Autonomia Supervisionada:** O sistema deve operar com alta autonomia (planejamento, execução, validação), mas sempre sob diretrizes claras de segurança e contenção.
- **Anti-Vibe Protocol:** Especificação antes de código. Validação obrigatória. Nada de "vibes", apenas engenharia sólida.
- **Modularidade Extrema:** Arquitetura hexagonal é mandatória. Separação clara entre Domínio (lógica pura), Portas (interfaces) e Adaptadores (implementações).
- **Segurança em Primeiro Lugar:** Todo código executado ou gerado deve ser isolado (sandbox) e validado antes de ser promovido para produção.

## Estilo de Código e Arquitetura
- **Linguagem:** TypeScript (rodando no runtime Bun).
- **Arquitetura:** Hexagonal (Ports & Adapters).
  - `ports/`: Interfaces abstratas que definem contratos.
  - `adapters/`: Implementações concretas (ex: SQLite, FileSystem, RPC).
  - `domain/`: Lógica de negócio pura, sem dependências externas.
- **Gerenciamento de Estado:** SQLite (via `better-sqlite3` em modo WAL) para persistência robusta e rápida.
- **Testes:** Vitest ou Bun Test. Testes unitários para o domínio, testes de integração para adaptadores.

## Fluxo de Trabalho de Engenharia Reversa
Todo componente do Auto Claude deve passar rigorosamente pelas 5 fases do protocolo:
1.  **RECON (Reconhecimento):** Análise da estrutura, stack e padrões sem modificar código.
2.  **DISSECT (Dissecação):** Mapeamento profundo de fluxo de dados, abstrações e "diamantes" (componentes críticos).
3.  **EXTRACT (Extração):** Isolamento de componentes reutilizáveis, prompts e tipos para a pasta `_extracted/`.
4.  **ADAPT (Adaptação):** Conversão para TypeScript/Bun e alinhamento com a arquitetura Ouroboros na pasta `_adapted/`.
5.  **INTEGRATE (Integração):** Conexão com o Daemon, Memória e Sistema de Agentes do Ouroboros.

## Documentação Obrigatória
- **ANALYSIS.md:** Relatório vivo de engenharia reversa (Tech Stack, Arquitetura, Avaliação).
- **STATUS.md:** Rastreamento atualizado da fase, progresso e bloqueios.
- **MANIFEST.md:** Inventário de tudo que foi extraído e adaptado.
- **CATALOG.md:** Registro central de todos os repositórios e seu status.

## Convenções de Nomenclatura
- **Diretórios:** `kebab-case` (ex: `auto-claude-core`, `agent-planner`).
- **Interfaces:** Prefixo `I` (ex: `IAgent`, `ITaskRunner`).
- **Commits:** Conventional Commits (ex: `feat(agent): implement planning logic`, `docs(analysis): update recon data`).
