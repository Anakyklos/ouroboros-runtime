# Tech Stack: Ouroboros (Engenharia Reversa do Auto Claude)

Esta stack foi definida para maximizar a compatibilidade com o Ouroboros Runtime, mantendo a integridade funcional do Auto Claude.

## Backend (Núcleo e Agentes)
- **Linguagem:** TypeScript (v5+)
- **Runtime:** Bun (v1.0+)
- **Gerenciador de Pacotes:** Bun
- **Banco de Dados:** SQLite (via `better-sqlite3` ou `bun:sqlite`)
- **Arquitetura:** Hexagonal (Ports & Adapters)
  - `ports/`: Interfaces abstratas
  - `adapters/`: Implementações concretas (File System, LLM APIs, Database)
  - `domain/`: Lógica pura de negócio (Agentes, Planejamento)

## Frontend (Interface do Usuário)
- **Framework:** React (v18+)
- **Runtime:** Electron (para manter a compatibilidade desktop do Auto Claude)
- **Estilização:** Tailwind CSS (ou CSS Modules, conforme o original)
- **Gerenciamento de Estado:** Zustand ou Context API (conforme necessidade)

## Ferramentas de IA e Agentes
- **Modelos de Linguagem:** Claude 3 (via API Anthropic), Gemini (via Google AI Studio)
- **Orquestração:** LangChain (adaptado para TS) ou implementação nativa de agentes

## DevOps e Qualidade
- **Linting/Formatting:** Biome (substituto rápido para ESLint/Prettier)
- **Testes:** Bun Test (Unitários e Integração)
- **CI/CD:** GitHub Actions (já integrado no Ouroboros)
- **Controle de Versão:** Git (com Conventional Commits)

## Dependências Críticas (Mapeamento)
| Auto Claude (Original - Python) | Ouroboros (Adaptado - TS/Bun) |
|---------------------------------|-------------------------------|
| `fastapi` / `flask`             | `ElysiaJS` ou `Hono`          |
| `pydantic`                      | `Zod`                         |
| `pytest`                        | `Bun Test`                    |
| `python-dotenv`                 | `Bun.env`                     |
| `sqlite3`                       | `bun:sqlite`                  |
