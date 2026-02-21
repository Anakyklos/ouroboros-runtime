<!-- ╔══════════════════════════════════════════════════════════════════╗ -->
<!-- ║       ENGENHARIA REVERSA — CATÁLOGO DE REPOSITÓRIOS CLONADOS     ║ -->
<!-- ╚══════════════════════════════════════════════════════════════════╝ -->

# 🔬 Engenharia Reversa — Central de Adaptação para o Ouroboros Runtime

> **Propósito:** Todo repositório clonado nesta pasta **DEVE** passar por engenharia reversa completa e ser adaptado para se integrar nativamente ao **Ouroboros Runtime**.

---

## 📋 Sumário

- [Objetivo](#-objetivo)
- [Protocolo de Engenharia Reversa](#-protocolo-de-engenharia-reversa)
- [Estrutura Obrigatória por Repositório](#-estrutura-obrigatória-por-repositório)
- [Catálogo Central](#-catálogo-central)
- [Padrões de Integração com o Ouroboros](#-padrões-de-integração-com-o-ouroboros)
- [Instruções para IAs](#-instruções-para-ias-agentes-autônomos)
- [Checklist de Validação](#-checklist-de-validação)
- [Regras de Nomenclatura e Organização](#-regras-de-nomenclatura-e-organização)

---

## 🎯 Objetivo

Esta pasta é o **laboratório de engenharia reversa** do Ouroboros Runtime. Todo repositório externo clonado aqui deve ser:

1. **Analisado** — Entender arquitetura, padrões, dependências e lógica central
2. **Documentado** — Gerar relatório técnico completo (`ANALYSIS.md`)
3. **Extraído** — Isolar componentes úteis, prompts, patterns e lógica reutilizável
4. **Adaptado** — Converter para TypeScript/Bun e alinhar com a arquitetura hexagonal do Ouroboros
5. **Integrado** — Plugar no Daemon, na memória persistente (SQLite) e no sistema de agentes (Council)
6. **Catalogado** — Registrar no `CATALOG.md` central para rastreabilidade

---

## 🔄 Protocolo de Engenharia Reversa

### Fase 1 — Reconhecimento (`RECON`)

> Executada **imediatamente** após clonar o repositório.

1. **Inicializar o Conductor (Gemini CLI)** — Executar `conductor init <pasta-do-repo>` ou usar a CLI do Gemini para criar a pasta `conductor/` e as fundações de conhecimento do projeto (`product.md`, `workflow.md`, `tech-stack.md`).
2. **Ler README, docs e arquivos de configuração** (package.json, pyproject.toml, Cargo.toml, etc.)
3. **Mapear a árvore de diretórios** — identificar a estrutura do projeto
4. **Identificar tech stack** — linguagem, framework, runtime, banco de dados (documentar no `conductor/tech-stack.md`)
5. **Listar dependências externas** — e avaliar compatibilidade com Bun/Node
6. **Localizar entrypoints** — main, CLI, daemon, API endpoints
7. **Identificar padrões arquiteturais** — MVC, hexagonal, event-driven, plugin system, etc.

**Output:** Seção `## Reconhecimento` no `ANALYSIS.md` e fundação criada na pasta `conductor/`.

---

### Fase 2 — Dissecação (`DISSECT`)

> Análise profunda do código-fonte.

1. **Mapear fluxo de dados** — input → processamento → output
2. **Identificar abstrações centrais** — interfaces, types, base classes
3. **Catalogar funções/módulos críticos** — os "diamantes" reutilizáveis
4. **Documentar prompts de IA** — se o repo contém agentes, extrair system prompts, tool definitions, persona descriptions
5. **Analisar padrões de estado** — como o sistema gerencia estado (memória, DB, cache, filesystem)
6. **Mapear integrações externas** — APIs, SDKs, serviços de terceiros
7. **Identificar anti-patterns** — código a NÃO replicar

**Output:** Seção `## Dissecação` no `ANALYSIS.md` com diagramas Mermaid.

---

### Fase 3 — Extração (`EXTRACT`)

> Isolar componentes reutilizáveis.

1. **Criar pasta `_extracted/`** dentro do repositório clonado
2. **Copiar módulos isoláveis** — sem dependências circulares
3. **Extrair prompts** → `_extracted/prompts/`
4. **Extrair schemas/types** → `_extracted/types/`
5. **Extrair padrões úteis** → `_extracted/patterns/`
6. **Extrair configurações** → `_extracted/configs/`
7. **Documentar dependências de cada extração** — o que precisa ser adaptado

**Output:** Pasta `_extracted/` com `MANIFEST.md` listando tudo extraído.

---

### Fase 4 — Adaptação (`ADAPT`)

> Converter para o runtime do Ouroboros.

1. **Converter para TypeScript** — se o original é Python/Go/Rust/etc.
2. **Alinhar com Bun runtime** — usar `Bun.serve()`, `Bun.file()`, `Bun.spawn()`, etc.
3. **Implementar como módulo Ouroboros** — seguir arquitetura hexagonal:
   - `ports/` — interfaces abstratas
   - `adapters/` — implementações concretas
   - `domain/` — lógica de negócio pura
4. **Integrar com memória persistente** — usar `better-sqlite3` via adapters existentes
5. **Respeitar o Anti-Vibe Protocol** — spec antes de code, validação obrigatória
6. **Garantir isolamento** — código adaptado vai para `.ouroboros/playground/` antes de promoção

**Output:** Pasta `_adapted/` com código pronto para integração.

---

### Fase 5 — Integração (`INTEGRATE`)

> Plugar no ecossistema Ouroboros.

1. **Registrar no Daemon** — se é um serviço, torná-lo disponível via RPC
2. **Expor como Tool** — se é uma funcionalidade, criar tool definition para o Council
3. **Conectar à memória** — persistir logs, resultados e estado no SQLite
4. **Adicionar ao Wave Execution** — se pode ser parallelizado, registrar como Wave task
5. **Criar testes** — unit + integration no padrão do Ouroboros
6. **Documentar API** — endpoints, parameters, responses

**Output:** PR ou commit com integração final + entrada no `CATALOG.md`.

---

## 📁 Estrutura Obrigatória por Repositório

Cada repositório clonado nesta pasta **DEVE** seguir esta estrutura:

```
engenharia reversa/
├── README.md                    ← (este arquivo)
├── CATALOG.md                   ← Índice central de todos os repos
│
├── <repo-name>/                 ← Repositório clonado (git clone)
│   ├── conductor/               ← 🧠 Base de conhecimento (Gemini CLI Conductor)
│   │   ├── product.md           ← Definição do produto e conceitos
│   │   ├── tech-stack.md        ← Stack tecnológico
│   │   ├── workflow.md          ← Regras de dev e anti-vibe protocol
│   │   └── tracks/              ← Planos de execução por feature
│   ├── ANALYSIS.md              ← 📝 Relatório de engenharia reversa (OBRIGATÓRIO)
│   ├── STATUS.md                ← 📊 Status atual (fase, progresso, bloqueios)
│   ├── _extracted/              ← 💎 Componentes extraídos
│   │   ├── MANIFEST.md          ← Lista do que foi extraído
│   │   ├── prompts/             ← System prompts, personas
│   │   ├── types/               ← Interfaces, schemas, types
│   │   ├── patterns/            ← Design patterns reutilizáveis
│   │   └── configs/             ← Configurações úteis
│   ├── _adapted/                ← 🔧 Código adaptado para Ouroboros
│   │   ├── ports/               ← Interfaces (hexagonal)
│   │   ├── adapters/            ← Implementações
│   │   └── domain/              ← Lógica de negócio
│   └── ... (código original)
│
├── <outro-repo>/
│   ├── ANALYSIS.md
│   ├── STATUS.md
│   ├── _extracted/
│   ├── _adapted/
│   └── ...
```

---

## 📚 Catálogo Central

Manter um arquivo `CATALOG.md` na raiz desta pasta com a seguinte tabela:

```markdown
# 📚 Catálogo de Repositórios — Engenharia Reversa

| # | Repositório | URL Original | Tech Stack | Fase Atual | Componentes Extraídos | Status |
|---|-------------|-------------|------------|------------|----------------------|--------|
| 1 | `oh-my-opencode` | github.com/... | TypeScript/Go | INTEGRATE | Agents, Prompts, Workflows | ✅ Completo |
| 2 | `example-repo` | github.com/... | Python | DISSECT | - | 🔄 Em progresso |
| 3 | `another-repo` | github.com/... | Rust | RECON | - | 📋 Pendente |
```

### Status Icons

| Icon | Significado |
|------|-------------|
| 📋 | `RECON` — Reconhecimento pendente |
| 🔍 | `DISSECT` — Em dissecação |
| 💎 | `EXTRACT` — Extração em andamento |
| 🔧 | `ADAPT` — Adaptação em andamento |
| 🔌 | `INTEGRATE` — Integração em andamento |
| ✅ | Completo e integrado |
| ⛔ | Abandonado (documentar motivo) |

---

## 🔌 Padrões de Integração com o Ouroboros

### Mapeamento de Conceitos

| Conceito do Repo Original | Equivalente no Ouroboros |
|---------------------------|------------------------|
| Project Planning / Tasks | Conductor Extension (`conductor/tracks/`) |
| Agent / Bot / Assistant | Council Agent (CLI → `cli/src/agents/`) |
| Plugin / Extension | Tool Definition (registrado no Daemon) |
| Database / Store | SQLite Adapter (`better-sqlite3`, WAL mode) |
| Config / Settings | `OuroborosEnvironment` (config.py / config.ts) |
| CLI Command | Concierge Intent (classificação + roteamento) |
| Background Service | Daemon Module (RPC endpoint) |
| Queue / Worker | Wave Execution Task |
| Prompt / System Message | Agent Persona File (`.agent/` ou `cli/src/agents/`) |
| API Endpoint | Gemini Bridge / Direct API |
| Test Suite | Vitest / Bun Test (playground validation) |

### Arquivo de Adaptação Padrão

Todo módulo adaptado deve expor uma interface mínima:

```typescript
// _adapted/ports/I<ModuleName>.ts
export interface IModuleName {
  /** Identificador único do módulo */
  readonly id: string;
  
  /** Inicializa o módulo com configurações do Ouroboros */
  initialize(config: OuroborosConfig): Promise<void>;
  
  /** Executa a funcionalidade principal */
  execute(input: unknown): Promise<ModuleResult>;
  
  /** Registra no Daemon para acesso via RPC */
  registerWithDaemon?(daemon: DaemonRPC): Promise<void>;
  
  /** Cleanup graceful */
  dispose(): Promise<void>;
}
```

---

## 🤖 Instruções para IAs (Agentes Autônomos)

> **Esta seção é destinada a agentes de IA** (Claude, Gemini, GPT, Ouroboros Council, etc.) que atuam sobre repositórios nesta pasta.

### Regras Absolutas

1. **SEMPRE leia este README primeiro** antes de qualquer ação nesta pasta
2. **NUNCA modifique o código original** do repositório clonado — apenas adicione `ANALYSIS.md`, `STATUS.md`, `_extracted/`, e `_adapted/`
3. **SEMPRE crie `ANALYSIS.md`** antes de extrair ou adaptar qualquer coisa
4. **SEMPRE atualize `CATALOG.md`** ao iniciar ou concluir trabalho em um repositório
5. **SEMPRE atualize `STATUS.md`** ao mudar de fase
6. **SIGA as 5 fases em ordem** — RECON → DISSECT → EXTRACT → ADAPT → INTEGRATE
7. **NÃO pule fases** — cada fase gera artefatos que alimentam a próxima

### Workflow para IAs — Passo a Passo

```
📥 TRIGGER: Novo repositório clonado nesta pasta

1. LER este README.md
2. LER o README do repositório clonado
3. Inicializar INFORMAÇÃO do projeto via Gemini CLI Conductor (`conductor/`)
4. CRIAR ANALYSIS.md com seção ## Reconhecimento
4. CRIAR STATUS.md com fase atual = RECON
5. ATUALIZAR CATALOG.md adicionando nova entrada
6. EXECUTAR cada fase sequencialmente (RECON → DISSECT → EXTRACT → ADAPT → INTEGRATE)
7. ATUALIZAR STATUS.md a cada mudança de fase
8. AO FINALIZAR: marcar como ✅ no CATALOG.md
```

### Template para `ANALYSIS.md`

```markdown
# 🔬 Análise de Engenharia Reversa: <repo-name>

> **URL Original:** <url>
> **Data de Início:** <YYYY-MM-DD>
> **Agente Responsável:** <nome do agente/IA>
> **Fase Atual:** RECON | DISSECT | EXTRACT | ADAPT | INTEGRATE

---

## Reconhecimento

### Tech Stack
- **Linguagem:** 
- **Runtime:** 
- **Framework:** 
- **Banco de Dados:** 
- **Dependências Críticas:** 

### Arquitetura
- **Padrão:** (MVC, Hexagonal, Event-Driven, etc.)
- **Entrypoints:** 
- **Estrutura de Diretórios:** (árvore simplificada)

### Avaliação Inicial
- **Relevância para Ouroboros:** (Alta/Média/Baixa)
- **Complexidade de Adaptação:** (Alta/Média/Baixa)
- **Componentes Reutilizáveis:** (lista)

---

## Dissecação

### Fluxo de Dados
(diagrama mermaid)

### Abstrações Centrais
(tabela de interfaces/classes/types críticos)

### Módulos Críticos ("Diamantes")
(lista com caminho, descrição, e valor para o Ouroboros)

### Prompts de IA (se aplicável)
(extrair system prompts, tool definitions, etc.)

### Anti-Patterns Identificados
(lista do que NÃO copiar)

---

## Extração

### Componentes Extraídos
(referência ao MANIFEST.md em _extracted/)

---

## Adaptação

### Conversões Realizadas
(quais módulos foram convertidos e para quais paths)

### Mapeamento de Dependências
(o que do Ouroboros substitui cada dependência original)

---

## Integração

### Pontos de Integração
(onde/como o módulo adaptado se conecta ao Ouroboros)

### Testes
(testes criados e resultados)
```

### Template para `STATUS.md`

```markdown
# 📊 Status: <repo-name>

| Campo | Valor |
|-------|-------|
| **Fase Atual** | 🔍 DISSECT |
| **Progresso** | 40% |
| **Último Update** | 2026-02-20 |
| **Agente** | Claude / Gemini / Ouroboros |
| **Bloqueios** | Nenhum |
| **Próxima Ação** | Mapear fluxo de dados do módulo X |
```

---

## ✅ Checklist de Validação

Antes de marcar um repositório como **✅ Completo**, verificar:

### Documentação
- [ ] Conductor inicializado (`conductor/` presente com arquivos base)
- [ ] `ANALYSIS.md` tem todas as 5 seções preenchidas
- [ ] `STATUS.md` está atualizado com fase = INTEGRATE ou completo
- [ ] `CATALOG.md` tem entrada atualizada
- [ ] `_extracted/MANIFEST.md` lista todos os componentes extraídos

### Código Adaptado
- [ ] Código convertido para TypeScript
- [ ] Compatível com Bun runtime
- [ ] Segue arquitetura hexagonal (ports/adapters/domain)
- [ ] Interfaces implementam `IModuleName` padrão
- [ ] Sem dependências externas incompatíveis

### Integração Ouroboros
- [ ] Registrado no Daemon (se serviço)
- [ ] Tool definition criada (se funcionalidade)
- [ ] Conectado à memória SQLite (se gerencia estado)
- [ ] Wave task registrada (se paralelizável)
- [ ] Testes criados e passando

### Qualidade
- [ ] Anti-Vibe Protocol respeitado (spec → impl → verify)
- [ ] Código isolado no `.ouroboros/playground/` antes de promoção
- [ ] Review humano realizado para promoção a `src/`

---

## 📛 Regras de Nomenclatura e Organização

### Nomes de Pastas

- Usar o **nome original do repositório** como nome da pasta
- Manter lowercase com hifens: `oh-my-opencode`, `langchain-agents`, etc.
- **NÃO** renomear o repositório clonado

### Nomes de Arquivos Gerados

| Arquivo | Obrigatório | Descrição |
|---------|:-----------:|-----------|
| `ANALYSIS.md` | ✅ | Relatório completo de engenharia reversa |
| `STATUS.md` | ✅ | Status atual e progresso |
| `_extracted/MANIFEST.md` | ✅ | Inventário de extrações |
| `_adapted/README.md` | ⚠️ | Instruções de uso do código adaptado |

### Tags para Classificação

Usar tags no `CATALOG.md` para facilitar busca:

| Tag | Significado |
|-----|------------|
| `#agent` | Contém lógica de agente/IA |
| `#tool` | Contém tools/funcionalidades |
| `#prompt` | Contém prompts de IA |
| `#pattern` | Contém design patterns úteis |
| `#infra` | Infraestrutura/DevOps |
| `#ui` | Interface de usuário |
| `#data` | Processamento de dados |
| `#security` | Segurança/autenticação |

---

## 🚀 Começando

### Para clonar um novo repositório para análise:

```bash
cd "/home/pedro/Projetos de I.A./ouroboros-runtime/engenharia reversa"

# Clonar o repositório
git clone <url-do-repositorio>

# Entrar na pasta
cd <nome-do-repo>

# Inicializar Base de Conhecimento (Gemini CLI Conductor)
conductor init .

# Criar estrutura de análise
mkdir -p _extracted/{prompts,types,patterns,configs}
mkdir -p _adapted/{ports,adapters,domain}
touch ANALYSIS.md STATUS.md _extracted/MANIFEST.md
```

### Para IAs — Comando de inicialização:

> Ao receber a instrução de analisar um novo repositório nesta pasta, execute:

```
1. Ler este README.md
2. Listar conteúdo do repositório
3. Ler README, package.json, e arquivos de config do repositório
4. Iniciar base de conhecimento Conductor se não existir (ou solicitar ao humano)
5. Criar ANALYSIS.md com fase RECON preenchida
6. Criar STATUS.md
7. Atualizar CATALOG.md
8. Prosseguir para fase DISSECT
```

---

> [!IMPORTANT]
> **Esta pasta é um ambiente vivo.** Repositórios serão continuamente clonados aqui.
> Cada análise deve ser **incremental** — não reanalysar o que já foi feito.
> Sempre consulte `CATALOG.md` e `STATUS.md` antes de iniciar trabalho em qualquer repo.

> [!TIP]
> **Para máxima eficiência**, IAs devem processar repos em lotes:
> 1. Reconhecimento rápido de todos os repos pendentes
> 2. Priorizar por relevância para o Ouroboros
> 3. Dissecação profunda apenas dos priorizados
