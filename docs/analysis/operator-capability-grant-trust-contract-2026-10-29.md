# Contrato de Concessão Explícita de Capabilities a Missions (Operator Capability Grant Trust Contract)

> **Estado:** PROPOSAL ONLY — nenhuma implementação de produção, nenhum contrato público ratificado, nenhuma autorização concedida.
> **Repositório:** `Anakyklos/ouroboros-runtime`
> **Issue:** #166 (P1), epic principal #70 (M1 Local Control Plane)
> **PR:** https://github.com/Anakyklos/ouroboros-runtime/pull/167 (revisão formal de REQUEST_CHANGES)
> **Base SHA auditado:** `4a0d6d52075bc665568e126124eb24ec8b8b2ed0` (`main`)
> **HEAD auditado anterior:** `56685502a6b1f94d3720109ce2b01706807901a8`
> **Bun (local):** `1.4.2` (CI pin: `1.3.9`)
> **Data:** 2026-10-29
> **Branch:** `docs/166-capability-grant-trust-contract`
> **Classificação de status:** `NEEDS_APPROVAL — proposta corrigida, aguardando revisão do mantenedor e decisão normativa de Pedro`

---

## Legenda de classificação

Toda afirmação neste documento carrega uma das seguintes classificações estritas:

- **PROVADO NO CÓDIGO** — verificável no código-fonte atual da base auditada (`main`).
- **CONTRATO EXISTENTE** — definido por contrato normativo ou documento aprovado presente no repositório.
- **PROPOSTA** — comportamento ou contrato proposto por este documento; não implementado.
- **HIPÓTESE** — possibilidade técnica ou arquitetural não comprovada; requer POC ou evidência empírica.
- **DECISÃO PENDENTE** — escolha de design ou escopo que requer aprovação explícita de Pedro / mantenedor.

---

## 1. Executive decision summary

**Recomendação arquitetural (PROPOSTA):** Adotar a **Alternativa B corrigida** — um **ledger durável e estritamente append-only** de eventos imutáveis de concessão e revogação de capabilities, armazenado no SQLite local do runtime. A autoridade de execução decorre exclusivamente da **associação atômica** mantida por cada grant individual ativo, validada contra uma fonte confiável independente de limites máximos do autorizador.

**Correções centrais em relação à revisão anterior (PROPOSTA):**

1. **Eliminação do produto cartesiano de autorização:** Fica extinta a hipótese de autorizar operações pela união independente de três listas globais (`capabilityIds`, `allowedEffectClasses`, `allowedRefPrefixes`). A proposta estabelece que **nenhuma capability pode operar sobre referências ou classes de efeito que não tenham sido concedidas juntas, no mesmo grant ativo e válido, emitido por autoridade legítima**. A allowlist materializada plana atual (`AllowedCapabilityScope`) é formalmente declarada insuficiente como fonte autoritativa de controle de acesso.
2. **Ledger verdadeiramente auditável e append-only:** Elimina-se toda mutação destrutiva (`UPDATE`) no histórico de concessões. Concessões e revogações passam a ser modeladas como eventos imutáveis distintos (`INSERT-only`), com identificadores estáveis, ordenação determinística, deduplicação idempotente por fingerprint canônico e redução determinística de estado após restart.
3. **Fail-closed estrito para Missions legadas e estados incertos:** Rejeita-se o fallback automático que convertia escopos legados sem proveniência em autorização ativa ou fazia união com novos grants. Missions sem proveniência verificável no ledger têm novas ações bloqueadas, preservando integralmente o histórico e as evidências de efeitos já executados. Nenhuma permissão histórica é transformada em grant sintético sem procedimento explícito.
4. **Revalidação autoritativa nos quatro gates e limites de concorrência:** A proposta audita o código atual de `main` e identifica as janelas de corrida existentes em `proposePlan`, `acceptPlan`, `dispatchStep` e no agendador. Estabelece quatro gates obrigatórios de revalidação autoritativa (proposta, aceitação, claim de invocation e handoff ao executor). Reconhece taxativamente que uma transação SQLite **não confere atomicidade a efeitos executados externamente**, formalizando o ciclo de vida dos efeitos (`prepared`, `submitted`, `uncertain`, `confirmed`) sem replay automático.
5. **Normalização tipada e diferenciação entre sanitização e defesa de injeção:** Normaliza-se o contrato tipado (`CAPABILITY_GRANT_PROTOCOL_VERSION` e `CAPABILITY_GRANT_CONTRACT_VERSION`), clarificam-se os modelos de expiração e revogação, e formaliza-se que proteção contra prompt injection reside na separação estrutural de dados vs. instruções e no caráter estritamente consultivo do LLM, jamais em mera sanitização de strings.

**Direção de implementação futura em slices isolados (PROPOSTA):**

- **Slice A** — Persistência do ledger append-only e política correlacionada de validação de grants (sem superfície pública RPC).
- **Slice B** — Operações autenticadas e auditáveis de concessão e revogação no Local Control Plane, sob escopo dedicado.
- **Slice C** — Planejamento consultivo e aceitação de planos sob revalidação autoritativa atômica.
- **Slice D** — Portões de dispatch, handoff ao executor, isolamento de incerteza e reconciliação sem replay.

**Invariantes centrais preservadas (CONTRATO EXISTENTE):**

1. `MissionIntent != Mission`; a Mission nasce dentro do Ouroboros.
2. Modelos de IA e planners são estritamente consultivos (*advisory*); código compilado e políticas determinísticas autorizam efeitos.
3. Um escopo de autenticação **não pode, sozinho**, conceder qualquer capability (decisão aprovada em `docs/decisions/2026-10-08-local-control-authz.md`).
4. `daemon.admin` e `mission.create` **não** concedem capabilities nem ampliam limites implicitamente.
5. `Capability Grant != Step Approval != Plan Acceptance != Dispatch Authorization`.

**Decisões que exigem aprovação explícita de Pedro (DECISÃO PENDENTE):** ver §14.
**Estado final:** `NEEDS_APPROVAL`. Nenhuma implementação de código realizada.

---

## 2. Baseline factual auditado

### 2.1 Referência Git e auditoria de HEAD

- **Base SHA auditado:** `4a0d6d52075bc665568e126124eb24ec8b8b2ed0` (`main`).
- **HEAD auditado anterior:** `56685502a6b1f94d3720109ce2b01706807901a8` (commit do PR #167 com review `REQUEST_CHANGES`).
- **Branch de trabalho:** `docs/166-capability-grant-trust-contract`.
- **Arquivos modificados:** Exclusivamente `docs/analysis/operator-capability-grant-trust-contract-2026-10-29.md`.

### 2.2 Lacuna reproduzida no runtime atual (PROVADO NO CÓDIGO)

Na base atual de `main`, a admissão pública de uma `MissionIntent` instancia Missions com escopo de capabilities estritamente vazio:

```typescript
// cli/src/daemon/local-control-admission.ts:25-29
const EMPTY_SCOPE: AllowedCapabilityScope = {
  capabilityIds: [],
  allowedEffectClasses: [],
  allowedRefPrefixes: [],
};
// cli/src/daemon/local-control-admission.ts:153
allowedCapabilityScope: EMPTY_SCOPE,
```

Consequência auditada: Toda Mission criada pelo operador via `mission.admit` nasce em estado `CREATED` com `EMPTY_SCOPE`. Sem uma operação de concessão, nenhum passo de plano pode ser validado (`PlanPolicyValidator` rejeita deterministicamente com `CAPABILITY_NOT_AUTHORIZED` ou `EFFECT_NOT_AUTHORIZED`) e nenhuma invocação pode ser despachada.

Adicionalmente, não existe na API pública do daemon (JSON-RPC ou UDS) nenhuma operação para conceder, listar ou revogar capabilities para uma Mission (PROVADO NO CÓDIGO via inspeção em `shared/local-control-*-contract.ts` e `cli/src/daemon/local-control-auth.ts`).

### 2.3 Arquivos, linhas e comportamento atual auditados

| Arquivo | Linhas | Fato auditado no código |
|---|---|---|
| `cli/src/mission/contracts.ts` | 126-136 | `AllowedCapabilityScope` define três listas planas: `capabilityIds`, `allowedEffectClasses`, `allowedRefPrefixes`. |
| `cli/src/mission/contracts.ts` | 140-165 | `ApprovalRequirement` vincula `approvalId` a um `scopeDescriptor` imutável com `effectFingerprint`. |
| `cli/src/mission/contracts.ts` | 230-265 | `Mission` embute `allowedCapabilityScope` como atributo direto. |
| `cli/src/mission/policy.ts` | 100-180 | `PlanPolicyValidator.validate()` avalia cada passo contra `mission.allowedCapabilityScope`. |
| `cli/src/mission/policy.ts` | 181-220 | Rejeita `CAPABILITY_NOT_AUTHORIZED` se `capabilityRequirement` não constar em `capabilityIds`. Rejeita `EFFECT_NOT_AUTHORIZED` se `effectClass` não constar em `allowedEffectClasses`. |
| `cli/src/mission/policy.ts` | 275-310 | `validateInputRefs()` checa se `inputRef` inicia com algum prefixo em `allowedRefPrefixes` de forma desacoplada da capability. |
| `cli/src/mission/mission-engine.ts` | 489-530 | `proposePlan()` invoca `this.policy.validate()` **antes** de abrir a transação SQLite `withTransaction`. Dentro da transação, revalida unicamente se a Mission não se tornou terminal. |
| `cli/src/mission/mission-engine.ts` | 562-630 | `acceptPlan()` **não executa revalidação de policy** contra o escopo atual da Mission antes de mover para `READY` / `WAITING_FOR_APPROVAL`. |
| `cli/src/mission/mission-engine.ts` | 726-820 | `dispatchStep()` invoca `this.policy.validate()` **fora e antes** de `withTransaction(claimInvocation)`. |
| `cli/src/mission/mission-engine.ts` | 880-915 | `withTransaction` em `dispatchStep` executa `claimInvocation` e move a Mission para `EXECUTING`, sem checar grants ativos na transação. |
| `cli/src/mission/mission-scheduler.ts` | 165-270 | O agendador processa invocações em batch e submete à seam de conectores sem novo gate de policy no momento do handoff de rede. |
| `cli/src/daemon/local-control-auth.ts` | 338-365 | `requiredLocalControlScope()` restringe estritamente `local_control.admit` a `mission.create` e comandos a `mission.control`. Não há escopo de concessão de capabilities. |
| `cli/src/mission/sqlite-mission-store.ts` | 295-320 | Tabela `missions` persiste `allowed_capability_scope TEXT NOT NULL DEFAULT '{}'`. Não existe tabela de grants. |
| `cli/src/mission/sqlite-mission-store.ts` | 1918-1945 | `withTransaction()` provê exclusão mútua local via fila de promessas em memória (`transactionQueue`) e transação `BEGIN/COMMIT/ROLLBACK` no SQLite. Publica mutações unicamente após commit bem-sucedido. |
| `cli/src/daemon/durable-projection.ts` | 40-75 | `projectMission()` projeta campos de resumo da Mission para o frontend/clientes sem expor `allowedCapabilityScope` nem dados de políticas. |

### 2.4 Evidência de testes e comportamento de concorrência em main

- Testes de integridade de admissão (`cli/src/daemon/local-control-admission.test.ts`): comprovam rejeição de campos desconhecidos, isolamento de requisições por cliente e idempotência por `requestId + payloadFingerprint`.
- Testes transacionais (`cli/src/mission/sqlite-mission-store.test.ts`): comprovam rollback completo em caso de erro e despacho de mutações somente pós-commit.
- Testes de agendamento e recuperação (`cli/src/mission/mission-scheduler.test.ts`): comprovam que invocações com `delivery.state !== "not_submitted"` entram em recuperação e reconciliação sem duplicação de claims.

---

## 3. Invariantes existentes

**CONTRATO EXISTENTE:**

- `MISSION_CONTRACT_VERSION = 1` (`cli/src/mission/contracts.ts`).
- O planner (LLM ou heurística) não tem autoridade para conceder, solicitar ou alterar escopo de capabilities (`PlanCandidate` não contém campo de autorização).
- `PlanPolicyValidator.validate()` é uma função pura e determinística em relação aos parâmetros fornecidos.
- Uma aprovação de passo (`ApprovalRequirement`) concedida para um efeito específico (comprovada por `effectFingerprint`) não pode ser reutilizada por outro passo com efeito divergente (`APPROVAL_SCOPE_MISMATCH`).
- Autenticação local em `local-control-auth.ts` valida credenciais via tokens HMAC/Bearer e revogação local (`LocalControlCredentialStore`). A presença de credencial válida confere acesso à rota RPC, mas **não** confere autoridade sobre capabilities do sistema operacional ou da máquina.
- A atomicidade do SQLite garante integridade ACID estritamente para o arquivo de banco de dados local.

**PROVADO NO CÓDIGO:**

- Toda Mission admitida por cliente externo possui escopo vazio (`EMPTY_SCOPE`).
- Apenas `recordApproval()` no `MissionEngine` pode transicionar um `ApprovalRequirement` de `granted: false` para `granted: true`.
- Concorrência de transações no daemon é serializada pela fila em memória de `sqlite-mission-store.ts`.

---

## 4. Alternativas comparadas

### 4.1 Alternativa A — Atualizar diretamente o escopo da Mission mediante operação autenticada

**Descrição (PROPOSTA de análise):** Uma nova chamada RPC autenticada executa um `UPDATE missions SET allowed_capability_scope = ...` diretamente na linha da Mission.

| Critério | Avaliação |
|---|---|
| Segurança e least privilege | **Fraca** — Concessões e revogações se misturam em um JSON único; impossível auditar quem concedeu o quê e por quê. |
| Simplicidade | **Alta** — Reutiliza a coluna existente na tabela `missions`. |
| Consistência transacional | **Média** — Uma transação SQLite simples, mas sem rastro de eventos. |
| Auditoria e provenance | **Nula** — Não preserva histórico de emissores, hashes de intenção ou motivo de revogação. |
| Revogação granular | **Inviável** — Revogar uma capability exige calcular diffs manuais arriscados sobre listas agregadas. |
| Risco de ampliação de autoridade | **Crítico** — Favorece o produto cartesiano e perda de proveniência de referências. |

**Veredito (PROPOSTA):** Rejeitada. Não atende aos requisitos de auditoria, rastreabilidade e segurança formal.

### 4.2 Alternativa B (Recomendada e Corrigida) — Ledger durável append-only de concessões e revogações com escopo efetivo associado

**Descrição (PROPOSTA):** O daemon mantém duas estruturas relacionais append-only no SQLite: `mission_capability_grants` (para eventos de concessão) e `mission_capability_revocations` (para eventos de revogação). Nenhuma linha é alterada via `UPDATE`. Cada grant vincula rigidamente a tupla `(capabilityId, effectClass, allowedRefPrefixes, resourceLimits)` ao emissor autenticado. A autorização de qualquer ação decorre da validação da tupla em um grant ativo no ledger.

| Critério | Avaliação |
|---|---|
| Segurança e least privilege | **Excelente** — Elimina produto cartesiano; autorização fail-closed; validação contra limites do autorizador. |
| Simplicidade | **Boa** — Segue exatamente o padrão comprovado de `mission_admissions` sem criar dependências externas. |
| Consistência transacional | **Excelente** — Eventos de ledger e transições da Mission residem na mesma transação atômica SQLite. |
| Auditoria e provenance | **Máxima** — Histórico imutável de emissão, versão de credencial do emissor, timestamp e revogações explícitas. |
| Revogação granular | **Excelente** — Revogação direcionada por `grantId`, idempotente, fail-closed para novas operações. |
| Recovery e restart | **Determinístico** — Reconstrução do estado ativo por redução pura dos eventos do ledger. |
| Risco de ampliação de autoridade | **Mínimo** — Composição granular por tupla; inexistência de super-grants por união desvinculada. |

**Veredito (PROPOSTA):** **Recomendada**. Representa a solução mais segura, limpa e alinhada à arquitetura do Ouroboros.

### 4.3 Alternativa C — Autoridade de policy externa ou registro independente de autorizações

**Descrição (PROPOSTA de análise):** Delegação da decisão de autorização para um daemon externo (ex.: OPA, Spire ou serviço HTTP de governança).

| Critério | Avaliação |
|---|---|
| Segurança e least privilege | Alta em tese, mas adiciona novo vetor de rede e novo boundary de confiança não auditado. |
| Complexidade operacional | **Inaceitável para M1** — Requer dependência de rede, latência externa, processo adicional e sincronização cross-process. |
| Consistência transacional | **Fraca** — Quebra a atomicidade SQLite; impossível coordenar 2PC sem complexidade desmedida. |
| Recovery após crash | Dependente da disponibilidade do serviço externo no boot. |

**Veredito (PROPOSTA):** Rejeitada para M1. O daemon headless local é a autoridade de execução local definida no épico #70.

---

## 5. Arquitetura recomendada (Alternativa B corrigida)

### 5.1 Visão geral do fluxo autoritativo

```text
Operador Autenticado (token com scope 'mission.grant_capabilities')
        │
        ▼
RPC local_control.grant_capabilities (payload estrito, sem autoridade auto-declarada)
        │
        ▼
CapabilityGrantService (daemon-side)
        │
        ├─► 1. Valida grantor contra fonte independente de limites (ex.: operator policy)
        ├─► 2. Valida compatibilidade da tupla (capabilityId ∈ limites, effectClass ∈ contract, refs ∈ limites)
        ├─► 3. Calcula fingerprint canônico (sha256 determinístico)
        │
        ▼
Transação SQLite Atômica (withTransaction):
        ├─► INSERT INTO mission_capability_grants (...) [registro imutável]
        ├─► Verifica integridade e consistência da Mission alvo
        ├─► Atualiza updatedAt da Mission
        └─► COMMIT (dispara publicação de mutações aos observadores)
```

### 5.2 Preservação estrita da tupla de grant (eliminação do produto cartesiano)

A falha central do modelo anterior residia em consolidar grants em três listas planas e independentes:
- `capabilityIds: string[]`
- `allowedEffectClasses: EffectClass[]`
- `allowedRefPrefixes: string[]`

No modelo corrigido (PROPOSTA), a autorização **nunca é avaliada contra listas globais unificadas**. Toda autorização preserva a tupla indissociável:

$$\text{Grant} = \langle \text{grantId}, \text{capabilityId}, \text{effectClass}, \text{allowedRefPrefixes}, \text{resourceLimits}, \text{grantorId}, \text{validity} \rangle$$

Um passo de plano `P` com requisito de capability `C`, classe de efeito `E` e conjunto de referências de entrada $R = \{r_1, r_2, \dots, r_k\}$ só é autorizado se existir **um mesmo grant ativo** $G$ tal que:
1. $C \in G.\text{capabilityIds}$
2. $E \in G.\text{allowedEffectClasses}$
3. $\forall r \in R, \exists p \in G.\text{allowedRefPrefixes} \text{ tal que } r \text{ inicia com } p$
4. $G$ não está expirado nem revogado no momento da verificação.
5. O emissor $G.\text{grantorId}$ permanece com autoridade válida.

Se uma operação necessitar de capabilities distintas, cada passo deve encontrar sua correspondência individual e completa em um grant ativo. **Não é permitida a combinação cruzada de campos entre grants distintos.**

### 5.3 Exemplo adversarial: Produto Cartesiano A × B

Para evidenciar a vulnerabilidade eliminada por esta regra, considere o seguinte cenário:

1. **Grant A emitido pelo Operador de Suporte:**
   - `capabilityId`: `fs.read_file`
   - `allowedEffectClasses`: `[READ]`
   - `allowedRefPrefixes`: `["storage://public/logs/"]`
2. **Grant B emitido pelo Operador Financeiro:**
   - `capabilityId`: `db.execute_ledger_transaction`
   - `allowedEffectClasses`: `[WRITE, EXECUTION]`
   - `allowedRefPrefixes`: `["db://financial/production/"]`

**Cenário vulnerável sob listas globais unificadas (REJEITADO):**
Se o sistema unisse as listas na Mission:
- `capabilityIds` = `["fs.read_file", "db.execute_ledger_transaction"]`
- `allowedEffectClasses` = `[READ, WRITE, EXECUTION]`
- `allowedRefPrefixes` = `["storage://public/logs/", "db://financial/production/"]`

Um planner malicioso ou induzido por prompt injection poderia propor o seguinte passo:
- Passo: `step-exfiltrate`
- `capabilityRequirement`: `fs.read_file`
- `effectClass`: `READ`
- `inputRefs`: `["db://financial/production/credentials.key"]`

Sob a verificação desacoplada:
- `fs.read_file` está em `capabilityIds`? **Sim.**
- `READ` está em `allowedEffectClasses`? **Sim.**
- `db://financial/production/credentials.key` começa com algum prefixo em `allowedRefPrefixes`? **Sim** (inicia com `db://financial/production/`).

**Resultado no modelo vulnerável:** A operação seria **AUTORIZADA**, permitindo que uma ferramenta de leitura de arquivos leia credenciais do banco financeiro, algo que **nenhum dos dois grants autorizou individualmente**.

**Resultado no modelo corrigido (PROPOSTA):**
- Testa-se contra o Grant A: `fs.read_file` bate, `READ` bate, mas a ref `db://financial/production/...` **não** inicia com `storage://public/logs/` $\rightarrow$ **Rejeitado**.
- Testa-se contra o Grant B: a ref bate, mas a capability `fs.read_file` **não** pertence ao Grant B $\rightarrow$ **Rejeitado**.
- Nenhum grant cobre a tupla conjuntamente $\rightarrow$ **Bloqueado deterministicamente com `CAPABILITY_REF_OUT_OF_GRANT_BOUNDS`**.

### 5.4 Fonte confiável e independente de limites máximos do grantor

**PROPOSTA + DECISÃO PENDENTE:** Um cliente autenticado não pode conceder autorizações que excedam seus próprios privilégios máximos provisionados. Esses limites máximos **não podem ser derivados de scopes genéricos** como `daemon.admin` ou `mission.create`.

Opções em avaliação (DECISÃO PENDENTE):
1. **Arquivo local de limites de governança (`grant-limits.json`)**: Arquivo de configuração de root/operador em `$OUROBOROS_DATA_DIR/security/operator-limits.json`, mode `0600`, mapeando `clientId` para suas allowlists máximas.
2. **Provisionamento na tabela `local_control_clients`**: Coluna `max_grant_limits_json` provisionada via CLI administrativa no ato da criação da credencial.

Regra mandatória: O `CapabilityGrantService` valida que:
$$G.\text{capabilityIds} \subseteq \text{Limit}.\text{maxCapabilities}$$
$$G.\text{allowedEffectClasses} \subseteq \text{Limit}.\text{maxEffectClasses}$$
$$G.\text{allowedRefPrefixes} \subseteq \text{Limit}.\text{maxRefPrefixes}$$
Qualquer discrepância resulta em rejeição imediata com `CAPABILITY_EXCEEDS_GRANTOR_LIMITS`.

---

## 6. Modelo de autoridade e composição determinística

### 6.1 Identidade, autoridade e ciclo de vida do emissor (grantor)

- **Quem pode conceder:** Cliente autenticado no Local Control Plane portador do scope específico `mission.grant_capabilities` (DECISÃO PENDENTE quanto ao nome exato).
- **Identidade imutável no ledger:** Toda concessão armazena o `grantorClientId` e a `grantorCredentialVersion` (hash do token ativo no momento do despacho).
- **Impossibilidade de forja:** Campos de autoridade não são aceitos no corpo da requisição RPC; são extraídos diretamente do objeto `LocalControlAuthenticatedClient` validado pelo daemon Fastify/UDS.

### 6.2 Escopo de cada concessão (tupla associada autoritativa)

Cada registro de concessão possui a seguinte estrutura formal:

```typescript
export interface CapabilityGrantRecord {
  readonly grantId: string;
  readonly missionId: string;
  readonly grantorClientId: string;
  readonly grantorCredentialVersion: string;
  readonly capabilityIds: readonly string[];
  readonly allowedEffectClasses: readonly EffectClass[];
  readonly allowedRefPrefixes: readonly string[];
  readonly resourceLimits?: {
    readonly maxInvocations?: number;
    readonly maxDurationMs?: number;
    readonly budgetUnits?: number;
  };
  readonly issuedAt: string;        // ISO 8601 UTC
  readonly expiresAt?: string;       // ISO 8601 UTC ou undefined (sem expiração temporal)
  readonly contractVersion: number;  // CAPABILITY_GRANT_CONTRACT_VERSION
  readonly fingerprint: string;      // sha256 canônico
  readonly createdAt: string;
}
```

Regras sintáticas e semânticas:
- Proibidos wildcards vazios (`""`) ou globais (`"*"`).
- `capabilityIds` devem existir no catálogo compilado do `CapabilityRegistry`.
- `allowedEffectClasses` deve ser subconjunto das classes declaradas pelas capabilities no catálogo.
- `allowedRefPrefixes` devem ser URIs canônicas bem formadas (ex.: `storage://`, `ref://`, `memory://`).

### 6.3 Regra determinística de composição e anti-escalada

1. **União de tuplas, não de campos:** Ter múltiplos grants ativos para uma mesma Mission significa que o executor pode executar ações cobertas pelo Grant A OU pelo Grant B. Não existe fusão de atributos entre A e B.
2. **Redução e Revogação:** A autorização cessa para uma tupla assim que for registrado um evento de revogação para o respectivo `grantId`.
3. **Impossibilidade de sobrelevação:** Nenhuma concessão pode elevar permissões além do limite provisionado do grantor. Concessões adicionadas por operadores distintos operam de forma disjunta.

### 6.4 Impacto e mudanças futuras em contratos e componentes

Para que a Alternativa B corrigida seja implementada futuramente nos slices adequados, as seguintes modificações estruturais serão necessárias:

1. **Em `cli/src/mission/contracts.ts`:**
   - O tipo `AllowedCapabilityScope` na interface `Mission` não pode permanecer como três listas globais. Ele deve ser substituído ou complementado por `activeGrants: readonly CapabilityGrantRecord[]` ou por uma projeção que preserve o vínculo estruturado `(capabilityId, effectClass, refPrefixes)`.
2. **Em `cli/src/mission/policy.ts` (`PlanPolicyValidator`):**
   - A função `validateStep` deve abandonar as consultas isoladas `inScope = capabilityIds.includes(...)` e `inMissionScope = allowedRefPrefixes.some(...)`.
   - O validador deve iterar sobre os grants ativos da Mission e verificar a cobertura integral:
     ```typescript
     const coveringGrant = mission.activeGrants.find(grant =>
       grantCoversStep(grant, step, contract)
     );
     if (!coveringGrant) {
       decision.reject(PolicyRejectionCode.CAPABILITY_NOT_AUTHORIZED, ...);
     }
     ```
3. **Nos gates de `MissionEngine`:**
   - `proposePlan`, `acceptPlan` e `dispatchStep` devem consultar o estado do ledger atômico de grants e assegurar que a cobertura do grant permanece válida durante a transição de estado.
4. **Nos gates de agendamento e despacho:**
   - A `CapabilityInvocation` gerada deve registrar a proveniência, incluindo o `grantId` autorizador no descritor de auditoria.

---

## 7. Contrato tipado proposto (PROPOSTA)

### 7.1 Identificadores e constantes normativas

```typescript
export const CAPABILITY_GRANT_PROTOCOL_VERSION = 1 as const;
export const CAPABILITY_GRANT_CONTRACT_VERSION = 1 as const;

export const CAPABILITY_GRANT_OPERATIONS = {
  GRANT: "mission.grant_capabilities",
  REVOKE: "mission.revoke_capability_grant",
  LIST: "mission.list_capability_grants",
} as const;
```

### 7.2 Request/Response de Concessão (`mission.grant_capabilities`)

```typescript
export interface CapabilityGrantRequest {
  readonly protocolVersion: typeof CAPABILITY_GRANT_PROTOCOL_VERSION;
  readonly operation: typeof CAPABILITY_GRANT_OPERATIONS.GRANT;
  readonly missionId: string;
  readonly grantId: string; // Chave de idempotência fornecida pelo cliente
  readonly capabilityIds: string[];
  readonly allowedEffectClasses: EffectClass[];
  readonly allowedRefPrefixes: string[];
  readonly resourceLimits?: {
    readonly maxInvocations?: number;
    readonly maxDurationMs?: number;
    readonly budgetUnits?: number;
  };
  readonly expiresAt?: string; // ISO 8601 opcional
}

export type CapabilityGrantResponse =
  | {
      readonly ok: true;
      readonly protocolVersion: typeof CAPABILITY_GRANT_PROTOCOL_VERSION;
      readonly operation: typeof CAPABILITY_GRANT_OPERATIONS.GRANT;
      readonly data: CapabilityGrantProjection;
    }
  | {
      readonly ok: false;
      readonly protocolVersion: typeof CAPABILITY_GRANT_PROTOCOL_VERSION;
      readonly operation: typeof CAPABILITY_GRANT_OPERATIONS.GRANT;
      readonly code: CapabilityGrantErrorCode;
      readonly message: string;
    };
```

### 7.3 Request/Response de Revogação (`mission.revoke_capability_grant`)

```typescript
export interface CapabilityGrantRevokeRequest {
  readonly protocolVersion: typeof CAPABILITY_GRANT_PROTOCOL_VERSION;
  readonly operation: typeof CAPABILITY_GRANT_OPERATIONS.REVOKE;
  readonly missionId: string;
  readonly grantId: string;       // ID do grant a revogar
  readonly revocationId: string;  // Chave de idempotência da revogação
  readonly reason: string;        // Justificativa obrigatória (sanitizada)
}

export type CapabilityGrantRevokeResponse =
  | {
      readonly ok: true;
      readonly protocolVersion: typeof CAPABILITY_GRANT_PROTOCOL_VERSION;
      readonly operation: typeof CAPABILITY_GRANT_OPERATIONS.REVOKE;
      readonly data: {
        readonly missionId: string;
        readonly grantId: string;
        readonly revocationId: string;
        readonly revokedAt: string;
      };
    }
  | {
      readonly ok: false;
      readonly protocolVersion: typeof CAPABILITY_GRANT_PROTOCOL_VERSION;
      readonly operation: typeof CAPABILITY_GRANT_OPERATIONS.REVOKE;
      readonly code: CapabilityGrantErrorCode;
      readonly message: string;
    };
```

### 7.4 Operação de Consulta (`mission.list_capability_grants`)

```typescript
export interface CapabilityGrantListRequest {
  readonly protocolVersion: typeof CAPABILITY_GRANT_PROTOCOL_VERSION;
  readonly operation: typeof CAPABILITY_GRANT_OPERATIONS.LIST;
  readonly missionId: string;
  readonly includeRevoked?: boolean;
}

export interface CapabilityGrantListResponse {
  readonly ok: true;
  readonly protocolVersion: typeof CAPABILITY_GRANT_PROTOCOL_VERSION;
  readonly operation: typeof CAPABILITY_GRANT_OPERATIONS.LIST;
  readonly data: {
    readonly missionId: string;
    readonly grants: CapabilityGrantProjection[];
  };
}
```

### 7.5 Projeções públicas e sanitizadas

```typescript
export interface CapabilityGrantProjection {
  readonly grantId: string;
  readonly missionId: string;
  readonly capabilityIds: readonly string[];
  readonly allowedEffectClasses: readonly EffectClass[];
  readonly allowedRefPrefixes: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly isRevoked: boolean;
  readonly revokedAt?: string;
  readonly revocationReason?: string;
}
```

*Nota de privacidade e segurança:* Segredos, tokens, versões de credenciais e fingerprints internos de hash não são projetados na interface pública.

### 7.6 Códigos de erro determinísticos

```text
INVALID_REQUEST
PROTOCOL_VERSION_REQUIRED
PROTOCOL_VERSION_UNSUPPORTED
INVALID_ID
INVALID_PAYLOAD
MISSION_NOT_FOUND
MISSION_TERMINAL
CAPABILITY_UNKNOWN
CAPABILITY_NOT_GRANTABLE
CAPABILITY_EXCEEDS_GRANTOR_LIMITS
EFFECT_CLASS_MISMATCH
REF_PREFIX_NOT_ALLOWED
GRANT_CONFLICT              // Mesmo grantId com payload divergente
REVOCATION_CONFLICT         // Mesmo revocationId com motivo divergente
GRANT_NOT_FOUND
GRANT_ALREADY_REVOKED
AUTHORITY_REVOKED           // Emissor do grant foi revogado
CAPABILITY_REF_OUT_OF_GRANT_BOUNDS
```

### 7.7 Limites de tamanho e restrições sintáticas

- `missionId`, `grantId`, `revocationId`: $\le 256$ caracteres, padrão alfanumérico estrito sem caracteres de controle.
- `capabilityIds`: $\le 64$ itens por grant; cada ID $\le 128$ caracteres.
- `allowedRefPrefixes`: $\le 64$ itens por grant; cada prefixo $\le 256$ caracteres.
- `reason` de revogação: $\le 1024$ caracteres (estruturalmente sanitizado).
- Tamanho total do payload JSON: $\le 65.536$ bytes.

---

## 8. Persistência, ledger auditável, idempotência e recovery

### 8.1 Schema do ledger append-only (sem mutações destrutivas)

Para garantir auditoria forense íntegra e eliminar a contradição de `UPDATE` destrutivo sobre dados imutáveis, propõe-se a criação de duas tabelas estritamente `INSERT-only` no SQLite:

```sql
-- 1. Registro imutável de eventos de concessão (Grant Ledger)
CREATE TABLE IF NOT EXISTS mission_capability_grants (
  grant_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  grantor_client_id TEXT NOT NULL,
  grantor_credential_version TEXT NOT NULL,
  capability_ids TEXT NOT NULL,         -- JSON array de strings
  allowed_effect_classes TEXT NOT NULL, -- JSON array de strings
  allowed_ref_prefixes TEXT NOT NULL,   -- JSON array de strings
  resource_limits TEXT NOT NULL,        -- JSON object
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  contract_version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,            -- sha256 canônico do payload
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, grant_id),
  FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE
);

-- 2. Registro imutável de eventos de revogação (Revocation Ledger)
CREATE TABLE IF NOT EXISTS mission_capability_revocations (
  revocation_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  target_grant_id TEXT NOT NULL,
  revoked_by_client_id TEXT NOT NULL,
  revoked_by_credential_version TEXT NOT NULL,
  reason TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,            -- sha256 canônico do evento de revogação
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, revocation_id),
  FOREIGN KEY (mission_id, target_grant_id) REFERENCES mission_capability_grants(mission_id, grant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_grants_mission_created
  ON mission_capability_grants(mission_id, created_at);

CREATE INDEX IF NOT EXISTS idx_revocations_target
  ON mission_capability_revocations(mission_id, target_grant_id);
```

### 8.2 Identidade estável e ordenação determinística

- `grant_id`: Chave primária estável fornecida na emissão ou derivada de forma unívoca, garantindo idempotência e referência imutável.
- `revocation_id`: Identificador estável do evento de revogação.
- **Ordenação determinística:** Os eventos são ordenados sequencialmente por `created_at` (ISO 8601 UTC) com critério de desempate por `rowid`/chave primária no SQLite.

### 8.3 Idempotência de concessão e revogação via fingerprint canônico

Seguindo o padrão arquitetural comprovado de `cli/src/daemon/local-control-admission.ts`:
1. **Replay idêntico de Concessão:** Se uma requisição com o mesmo `(missionId, grantId)` e idêntico `fingerprint` for submetida, o serviço retorna o registro já gravado com sucesso (`HTTP 200 / ok: true`), sem gerar nova inserção.
2. **Conflito de Concessão:** Se o `grantId` coincidir, mas o payload/fingerprint divergir, a operação é sumariamente rejeitada com `GRANT_CONFLICT`, impedindo qualquer mutação disfarçada.
3. **Idempotência de Revogação:** Requisitar a revogação de um grant já revogado com a mesma chave e justificativa retorna sucesso idempotente. Motivos divergentes para o mesmo `revocationId` resultam em `REVOCATION_CONFLICT`.

### 8.4 Reconstrução determinística (Replay / Redução após restart)

Após um restart abrupto ou crash do daemon, o estado de autorização de qualquer Mission é reconstruído deterministicamente através de uma função de redução pura:

$$S_{\text{active}}(M) = \text{Reduce}(\text{Grants}(M), \text{Revocations}(M), T_{\text{now}}, \text{CredentialStatus})$$

Um grant $g \in \text{Grants}(M)$ é considerado ativo se e somente se:
1. Não existe nenhuma linha em `mission_capability_revocations` onde `target_grant_id = g.grant_id`.
2. $g.\text{expires_at}$ é nulo ou $T_{\text{now}} < g.\text{expires_at}$.
3. O cliente emissor $g.\text{grantor_client_id}$ não foi revogado na autoridade de credenciais (conforme política definida em §8.6).

A projeção materializada em memória é derivada unicamente dessa redução. Se o SQLite for reiniciado, a integridade é restabelecida sem perda de estado e sem mutação no disco.

### 8.5 Transações SQLite, atomicidade e rollback local

- Toda inserção no ledger append-only e eventual atualização de metadados da Mission ocorrem estritamente dentro de `store.withTransaction()`.
- O mecanismo de `withTransaction()` em `cli/src/mission/sqlite-mission-store.ts` utiliza `BEGIN IMMEDIATE`, garantindo exclusão mútua contra leituras sujas e assegurando que falhas disparem `ROLLBACK` completo.
- Mutações para eventos de domínio (`pendingMutations`) só são publicadas após o `COMMIT` bem-sucedido no SQLite. Se houver falha de validação ou escrita, nenhum evento é emitido aos observadores (PROVADO NO CÓDIGO).

### 8.6 Rotação de credenciais versus revogação de grants

É mandatório distinguir os efeitos de segurança:
1. **Rotação de Credencial do Operador:**
   - Ocorre quando o operador renova seu token. A `credentialVersion` do cliente avança.
   - **Regra:** Grants emitidos legitimamente sob a versão anterior permanecem válidos até expiração ou revogação explícita, pois representam delegação autorizada registrada em ledger. A versão antiga não pode mais ser utilizada para emitir novos grants.
2. **Revogação da Credencial do Operador:**
   - Ocorre quando um operador é desautorizado ou demitido (`auth revoke <clientId>`).
   - **Regra (Fail-Closed):** O daemon marca a credencial como revogada no `LocalControlCredentialStore`. Nos gates de revalidação (§9.2), qualquer grant emitido por um operador cuja credencial foi revogada é considerado **inativo para novos efeitos futuros**. Efeitos já confirmados continuam válidos no histórico forense.
3. **Revogação de Grant Individual:**
   - Ocorre via `mission.revoke_capability_grant`. Cessa a autorização daquela tupla específica sem impactar a credencial do operador nem outros grants.

---

## 9. Revogação, concorrência e limites de atomicidade

### 9.1 Auditoria do comportamento atual de main (janelas de corrida identificadas)

A auditoria minuciosa do código atual de `main` revela quatro janelas de corrida críticas que tornam a sincronização entre revogação e execução dependente de correções normativas:

1. **Janela em `proposePlan()` (`cli/src/mission/mission-engine.ts:489-530`):**
   - O método executa `this.policy.validate(mission, candidate)` na linha 506, **fora da transação**.
   - Apenas na linha 515 abre `this.store.withTransaction()`. Dentro da transação, o código revalida unicamente se a Mission é terminal.
   - *Vulnerabilidade de corrida:* Se um grant for revogado entre as linhas 506 e 515, um plano baseado em capabilities recém-revogadas será gravado com status `proposed`.
2. **Janela em `acceptPlan()` (`cli/src/mission/mission-engine.ts:562-630`):**
   - O método recupera a revisão proposta e entra em `withTransaction()`.
   - O método **não executa nenhuma revalidação de policy** antes de marcar a revisão como `accepted` e mover a Mission para `READY` ou `WAITING_FOR_APPROVAL`.
   - *Vulnerabilidade de corrida:* Se a revogação ocorreu enquanto o plano estava em proposta, `acceptPlan` aceitará cegamente passos que já não possuem cobertura de grant.
3. **Janela em `dispatchStep()` (`cli/src/mission/mission-engine.ts:726-890`):**
   - O método executa a revalidação de policy na linha 778, **fora e antes** de `this.store.withTransaction()`.
   - Na linha 884, dentro da transação, executa `claimInvocation(invocation)`.
   - *Vulnerabilidade de corrida:* Se uma revogação for commitada entre a validação de policy e o claim, a invocação será criada e gravada como `dispatched`, violando a revogação.
4. **Janela de Handoff ao Executor (`cli/src/mission/mission-scheduler.ts:165-220`):**
   - A invocação persistida no SQLite com `delivery.state = "not_submitted"` é lida pelo agendador e enviada ao conector externo.
   - Entre a gravação do claim e a transmissão pela rede/processo, pode transcorrer tempo arbitrário. Se a revogação ocorrer nesse intervalo, o conector submeterá o efeito se não houver um gate imediatamente anterior à entrega.

### 9.2 Exigências de revalidação autoritativa nos quatro gates

Para sanar categoricamente essas janelas, a proposta define quatro gates autoritativos de revalidação obrigatória:

```text
[Plano Proposto] ──Gate 1──► [Plano Aceito] ──Gate 2──► [Invocation Claimada] ──Gate 3──► [Handoff Externo] ──Gate 4──► [Executor]
   (Propose)                    (Accept)                     (Dispatch/Claim)                 (Pre-Submission)
```

1. **Gate 1 — Validação na Proposta (`proposePlan`):**
   - A validação de conformidade da tupla deve ocorrer sob estado consistente ou ser revalidada antes da escrita da revisão.
2. **Gate 2 — Revalidação na Aceitação (`acceptPlan`):**
   - Dentro da transação atômica de aceitação, `acceptPlan` deve revalidar se todos os passos do plano proposto continuam cobertos por grants ativos no ledger. Caso contrário, a aceitação é rejeitada com erro de autorização expirada/revogada.
3. **Gate 3 — Revalidação no Claim da Invocação (`dispatchStep`):**
   - Dentro de `store.withTransaction`, antes de persistir o claim da `CapabilityInvocation`, o motor deve verificar se o `grantId` associado ao passo permanece ativo e não revogado. Se revogado, o claim é abortado com `DispatchRejectedError`.
4. **Gate 4 — Revalidação Imediatamente Pré-Submissão (Pre-Submission Handoff Gate):**
   - Imediatamente antes de chamar a interface do conector ou despachar o payload para a rede/subprocesso, o scheduler/seam verifica se o grant não foi revogado. Se revogado, a entrega é abortada sem submissão externa (`delivery.state` transiciona para `failed` com código `REVOKED_BEFORE_SUBMISSION`).

### 9.3 Linearização e ordem determinística de concorrência

A concorrência entre operações de revogação (`revoke`) e despacho (`dispatch`) é linearizada pela ordem de commit no SQLite:

1. **Cenário A — Revoke comita antes do Claim da Invocation:**
   - O `dispatchStep` (Gate 3) tenta adquirir a transação. Ao ler os grants ativos, constata a revogação no ledger.
   - **Resultado:** A invocação não é criada. A chamada falha com `DispatchRejectedError`. Comportamento estritamente fail-closed.
2. **Cenário B — Claim da Invocation comita antes do Revoke:**
   - A invocação foi gravada como `prepared / not_submitted`.
   - O `revoke` comita em seguida no SQLite.
   - O Gate 4 (Pre-Submission) detecta a revogação no momento em que o scheduler tenta submeter o efeito.
   - **Resultado:** O efeito externo **NÃO é submetido**. A invocação é cancelada localmente de forma segura.
3. **Cenário C — Revoke comita durante ou após a submissão externa:**
   - O efeito já cruzou o limite do processo (a requisição TCP ou o comando OS já foram emitidos).
   - O runtime **não pode garantir rollback físico** do efeito externo (§9.4). O status do efeito é tratado conforme o ciclo de vida (§9.5).

### 9.4 Reconhecimento da impossibilidade de atomicidade SQLite + efeito externo

> [!IMPORTANT]
> **Princípio de Realidade Operacional:**
> Uma transação no SQLite é puramente local ao arquivo de banco de dados do host. **Ela NÃO confere e NUNCA poderá conferir atomicidade a um efeito executado no mundo real** (como comandos shell, mutações de arquivos em disco, requisições de rede ou transações remotas de API).

Qualquer alegação de que um rollback no SQLite desfaz um efeito externo executado é arquiteturalmente falsa. Uma vez que o payload cruza a fronteira do processo do daemon, a atomicidade transacional local encerra-se. A segurança depende de delimitar o ciclo de vida dos efeitos e proibir presunções ingênuas de sucesso ou retry.

### 9.5 Ciclo de vida dos efeitos e ausência de replay automático

Os efeitos de capabilities seguem o ciclo de estados estrito já previsto na arquitetura de entrega durável (#50):

```text
       ┌──────────────┐
       │   PREPARED   │ (Gravado no SQLite; delivery.state = "not_submitted")
       └──────┬───────┘
              │ Gate 4 (Revalidação pré-submissão)
              ▼
       ┌──────────────┐
       │  SUBMITTED   │ (Cruzou a fronteira do conector; delivery.state = "running")
       └───┬──────┬───┘
   Timeout │      │ Confirmação
   /Crash  │      │
           ▼      ▼
┌────────────┐  ┌─────────────┐
│ UNCERTAIN  │  │  CONFIRMED  │ (completed / failed no mundo real)
└─────┬──────┘  └─────────────┘
      │
      ▼
Reconciliação Exclusiva (ReconciliationAuthority)
(PROIBIDO REPLAY AUTOMÁTICO)
```

1. **Efeitos Preparados (`prepared`):** Invocação gravada no SQLite, mas ainda não despachada ao conector. Revogação cancela a entrega localmente.
2. **Efeitos Submetidos (`submitted`):** Invocação enviada ao executor. Se ocorrer revogação, o runtime registra intenção de cancelamento (`cancellation.requested = true`), mas não altera o fato da transmissão.
3. **Efeitos Incertos (`uncertain`):** Queda de conexão, timeout ou crash durante a execução. **É ESTRITAMENTE PROIBIDO REPLAY AUTOMÁTICO.** O runtime não sabe se a operação foi executada na ponta remota. A resolução só pode ocorrer via `ReconciliationAuthority` determinística ou intervenção do operador.
4. **Efeitos Confirmados (`confirmed`):** Efeitos com evidência definitiva registrada (`completed` ou `failed`). Uma revogação de grant posterior **nunca reverte, não apaga e não invalida a evidência do efeito executado**. O passado permanece imutável e auditável.

---

## 10. Compatibilidade e migração com Missions legadas

### 10.1 Os cinco cenários de compatibilidade e proveniência

A proposta abandona a conversão permissiva e classifica formalmente cinco cenários distintos para instalações existentes e novas:

| Cenário | Condição do Ambiente / Dados | Comportamento para Ações Futuras (Proposta / Aceitação / Dispatch) | Preservação de Histórico e Evidências |
|---|---|---|---|
| **1. Escopo histórico com autoridade verificável** | Ledger de grants presente, íntegro e correlacionado com o histórico da Mission. | **Permitido.** Escopo ativo é derivado deterministicamente pela redução dos eventos ativos no ledger. | Integralmente preservado. |
| **2. Escopo histórico sem proveniência comprovada** | Mission pré-existente (v1) criada antes do ledger, contendo `allowedCapabilityScope` no banco, mas zero eventos no ledger de grants. | **FAIL-CLOSED (Bloqueado).** O escopo persistido antigo **NÃO** é tratado como autorização ativa e **NÃO** faz união com novos grants. Novas propostas, aceitações e dispatches são rejeitados até concessão explícita em ledger. | **Totalmente preservado.** Invocations passadas, revisões e evidências permanecem imutáveis para auditoria. |
| **3. Ledger ausente em instalação nova** | Instalação limpa do runtime do zero. | **Permitido.** Tabelas são criadas limpas. Toda nova Mission nasce com escopo vazio (`EMPTY_SCOPE`). Concessões ocorrem exclusivamente via ledger. | N/A (banco novo). |
| **4. Ledger ausente após migração** | Banco de dados existente atualizado via migration; tabelas de ledger criadas, porém vazias de registros históricos. | **FAIL-CLOSED (Bloqueado).** Aplica-se a regra do Cenário 2. As Missions antigas mantêm histórico forense preservado, mas nenhuma nova capability é executada sem concessão legítima por operador. | Totalmente preservado. Nenhuma deleção de dados. |
| **5. Ledger corrompido / checksum mismatch** | Registros de grants ou revogações com integridade violada, JSON inválido ou divergência de fingerprint. | **FAIL-CLOSED IMEDIATO.** A Mission afetada é congelada para novas operações. Erro estruturado de auditoria é logado. Nenhuma inferência permissiva é tolerada. | Evidências existentes intactas. Operação bloqueada. |

### 10.2 Princípio de não-conversão implícita em grants sintéticos

> [!WARNING]
> É terminantemente vedado ao código de migração criar "grants sintéticos", "grants mágicos" ou inferir intenção de autorizadores do passado. Qualquer concessão de autoridade deve derivar de uma transação explícita, assinada ou submetida por um operador autenticado e auditável.

### 10.3 Preservação integral do histórico e evidências passadas

Nenhuma política fail-closed para novas operações afetará:
- Invocations pretéritas com status `completed` ou `failed`.
- Atribuições de evidência em `evidence_refs` da Mission.
- Atestados de verificação de critérios de aceitação já registrados.
- O histórico de revisões propostas, aceitas ou substituídas.

---

## 11. Threat model e análise de segurança

### 11.1 Matriz de ameaças e controles

| Ameaça / Vetor | Impacto Potencial | Controle Arquitetural Proposto | Teste Obrigatório |
|---|---|---|---|
| **Escalação por produto cartesiano A × B** | Execução de capabilities com referências de outros grants | Preservação estrita da tupla no grant; validação atômica correlacionada (§5.2) | `test-grant-cartesian-rejection` |
| **Operador concedendo além dos limites** | Elevação de privilégio do autorizador | Validação obrigatória contra fonte confiável de limites máximos (§5.4) | `test-grantor-limit-enforcement` |
| **Bypass de escopo via `mission.create`** | Criação de Mission já com capabilities ativas | Admissão cria Missions estritamente em `EMPTY_SCOPE` (PROVADO NO CÓDIGO) | `test-admission-empty-scope` |
| **Injeção de campos de autoridade pelo planner** | Planner inventando aprovações ou grants | Rejeição estrita no validador; `PlanCandidate` é dado passivo sem autoridade | `policy.test.ts` |
| **Sequestro de aprovação (`approval hijacking`)** | Reuso de aprovação concedida para efeito diferente | Validação imutável via `effectFingerprint` de 4 fatores (PROVADO NO CÓDIGO) | `policy.test.ts` |
| **Corrida entre Revoke e Dispatch** | Invocação despachada após revogação | Serialização transacional e revalidação nos quatro gates (§9.2) | `test-revoke-dispatch-race` |
| **Replay após queda do daemon** | Re-execução indevida de efeito incerto | Proibição de replay automático; isolamento do estado `uncertain` (§9.5) | `test-uncertain-recovery-barrier` |
| **Falsificação de identidade de emissor** | Parâmetros de grantor injetados no corpo RPC | Identidade e versão de credencial extraídas unicamente da sessão autenticada | `test-spoofed-grantor-rejection` |
| **Corrupção parcial do ledger** | Assunção permissiva diante de dados inválidos | Fail-closed determinístico; congelamento de novas operações da Mission | `test-corrupted-ledger-fail-closed` |
| **Vazamento de tokens em projeções** | Exposição de credenciais e segredos | Projeções sanitizadas em `durable-projection.ts`; sem segredos no wire | `test-sanitized-projections` |

### 11.2 Defesa contra prompt injection vs mera sanitização de texto

É fundamental formalizar a distinção entre **higiene sintática** e **segurança de autoridade**:
- **Sanitização de texto (`sanitizeText`):** Remove caracteres de controle, trunca comprimentos excessivos e evita quebras de formatação no terminal ou logs. **Sanitização NÃO previne nem resolve prompt injection.**
- **Defesa Arquitetural contra Prompt Injection:**
  1. **Separação Estrutural de Dados vs. Instruções:** As diretivas do planner (`PlanCandidate`) são tratadas exclusivamente como **dados consultivos passivos**, jamais como código executável ou concessão de autoridade.
  2. **Impotência de Autoridade do Modelo:** O modelo de IA não tem acesso a chaves criptográficas, não emite tokens de autorização, não invoca rotas de grant e não pode alterar o ledger do SQLite.
  3. **Validação Determinística Compilada:** O `PlanPolicyValidator` e o `MissionEngine` são escritos em código TypeScript compilado e determinístico. Mesmo que o modelo seja 100% comprometido por injeção adversária e declare que tem autoridade ilimitada, o validador verificará o ledger relacional no SQLite e rejeitará sumariamente a tentativa.

---

## 12. Matriz de testes projetados (futuros)

Para homologação futura das alterações propostas, a seguinte suíte de testes em ambiente real (com SQLite temporário e sem mocks voláteis) deverá ser implementada:

| Identificador do Teste | Escopo / Cenário Validado | Critério de Aceite Estrito |
|---|---|---|
| `test_grant_cartesian_product_adversarial` | Concede Grant A (`capA`, `refsA`) e Grant B (`capB`, `refsB`). Propõe step com `capA` + `refsB`. | Rejeição determinística por falta de grant com cobertura conjunta. |
| `test_grant_append_only_immutability` | Emite grant e subsequente revogação. | Nenhuma operação `UPDATE` executada no banco; duas linhas `INSERT` registradas. |
| `test_grant_idempotency_replay_and_conflict` | Replay com mesmo hash $\rightarrow$ sucesso idempotente. Replay com hash divergente $\rightarrow$ erro `GRANT_CONFLICT`. | Zero mutações espúrias; respostas idempotentes comprovadas. |
| `test_legacy_mission_fail_closed` | Carrega banco com Mission v1 (sem ledger). Tenta propor e despachar novo step. | Bloqueio imediato fail-closed; histórico e evidências passadas intactos. |
| `test_race_revoke_during_proposal` | Revogação comita concorrentemente entre validação de política e persistência da proposta. | Proposta abortada ou rejeitada na transação. |
| `test_race_revoke_before_accept` | Plano proposto com grant ativo; grant revogado antes do `acceptPlan`. | `acceptPlan` revalida e falha; Mission não move para `READY`. |
| `test_race_revoke_before_claim` | Revogação comita imediatamente antes de `claimInvocation` dentro de `withTransaction`. | Claim abortado; nenhuma invocation criada. |
| `test_race_revoke_before_handoff` | Invocação gravada como `not_submitted`; grant revogado antes do despacho ao conector. | Gate 4 bloqueia envio ao conector; `delivery.state` vira `failed`. |
| `test_uncertain_delivery_no_replay` | Simula falha de entrega externa deixando estado `uncertain`. Emite revogação e dispara tick do scheduler. | Nenhum replay automático executado. Resolução unicamente via autoridade. |
| `test_grantor_revocation_cascading_check` | Emissor do grant é revogado no `LocalControlCredentialStore`. | Novos dispatches sob os grants daquele emissor são bloqueados. |

---

## 13. Decomposição futura (slices independentes de implementação)

A implementação do contrato proposto não deve ser feita de forma monolítica. Propõe-se a seguinte divisão em quatro slices independentes:

### Slice A — Persistência do ledger append-only e validação por tupla correlacionada
- **Objetivo:** Adicionar tabelas `mission_capability_grants` e `mission_capability_revocations` no `SqliteMissionStore`, método de redução determinística de estado e reescrita do `PlanPolicyValidator` para validação por tupla indissociável (eliminando o produto cartesiano).
- **Superfície pública:** Nenhuma (sem RPC ou CLI).
- **Critério de parada:** Se a validação por tupla quebrar a compatibilidade de interfaces sem migração segura, pausar.

### Slice B — Operações administrativas de Concessão e Revogação no Local Control Plane
- **Objetivo:** Implementar os endpoints JSON-RPC/UDS `mission.grant_capabilities`, `mission.revoke_capability_grant` e `mission.list_capability_grants` no daemon, protegidos pelo escopo `mission.grant_capabilities` e validados contra limites do grantor.
- **Superfície pública:** Rotas internas versionadas no controle local.
- **Critério de parada:** Rejeitar qualquer concessão se o emissor não possuir limites explicitamente configurados.

### Slice C — Revalidação autoritativa nos portões de planejamento e aceitação
- **Objetivo:** Adaptar `proposePlan()` e `acceptPlan()` no `MissionEngine` para fechar as janelas de corrida 1 e 2 (§9.1), garantindo revalidação atômica antes de persistir propostas ou aceitar planos.
- **Superfície pública:** Nenhuma alteração de assinatura.
- **Critério de parada:** Qualquer plano sem cobertura ativa deve ser rejeitado sem alterar estado da Mission.

### Slice D — Portões de dispatch, entrega e barreira de incerteza
- **Objetivo:** Implementar o Gate 3 (dentro de `claimInvocation`) e Gate 4 (pre-submission handoff no `MissionSchedulerDriver`), integrando com o ciclo de entrega de #50 e isolando efeitos incertos.
- **Superfície pública:** Nenhuma.
- **Critério de parada:** Garantir que nenhum efeito incerto sofra retry automático.

---

## 14. Decisões que exigem aprovação de Pedro (DECISÃO PENDENTE)

As seguintes questões arquiteturais e normativas permanecem em aberto e **dependem de aprovação explícita de Pedro**:

1. **Nomenclatura do escopo de autorização para concessão:** Adotar `mission.grant_capabilities`, `capability.grant` ou integrar em um escopo administrativo mais amplo? (Recomendação: `mission.grant_capabilities` dedicado).
2. **Localização da fonte de limites máximos do grantor:** Optar por arquivo de configuração estático (`$OUROBOROS_DATA_DIR/security/operator-limits.json`) ou coluna adicional provisionada na tabela `local_control_clients`? (Recomendação para M1: arquivo local de governança).
3. **Política de expiração default:** Permitir grants sem data de expiração (`expiresAt` opcional, revogável a qualquer tempo) ou exigir prazo de validade máximo mandatório (ex.: leases de 24 horas)?
4. **Política diante de revogação de credencial de operador:** Desativar grants emitidos para novos efeitos futuros (fail-closed, recomendado) ou disparar revogação em cascata com cancelamento de planos aceitos?
5. **Escopo para leitura de grants (`mission.list_capability_grants`):** Permitir leitura com o escopo existente `mission.read` ou criar escopo específico para evitar enumeração de capabilities por clientes de telemetria básica?
6. **Formato final de migração de Missions legadas:** Confirmar o tratamento fail-closed estrito sem criação de grants sintéticos para dados históricos.
7. **Política de concorrência de múltiplos operadores:** Admitir revogação cruzada (Operador B revogar grant emitido pelo Operador A) se ambos possuírem autoridade de governança, ou restringir a revogação ao emissor original e `daemon.admin`?

---

## 15. Evidências e referências ao código auditado

**PROVADO NO CÓDIGO:**
- `cli/src/daemon/local-control-admission.ts:25-35, 153` — Criação de Mission com `EMPTY_SCOPE`.
- `cli/src/mission/contracts.ts:126-136` — Representação plana de `AllowedCapabilityScope`.
- `cli/src/mission/policy.ts:100-220, 275-310` — Validação desacoplada de capability e referências em `PlanPolicyValidator`.
- `cli/src/mission/mission-engine.ts:489-530` — `proposePlan` valida policy fora da transação.
- `cli/src/mission/mission-engine.ts:562-630` — `acceptPlan` não revalida policy contra escopo atual.
- `cli/src/mission/mission-engine.ts:726-890` — `dispatchStep` valida policy fora de `claimInvocation`.
- `cli/src/mission/mission-scheduler.ts:165-270` — Scheduler despacha invocações preparadas sem revalidação de entrega.
- `cli/src/mission/sqlite-mission-store.ts:1918-1945` — Fila em memória `transactionQueue` e semântica de `withTransaction`.
- `cli/src/daemon/local-control-auth.ts:338-365` — Mapeamento estrito de métodos em `requiredLocalControlScope`.
- `cli/src/daemon/durable-projection.ts:40-75` — `projectMission` e `projectInvocation` sem exposição de políticas ou segredos.

**CONTRATO EXISTENTE:**
- `docs/MISSION_CONTRACT.md` — Contrato v1 de Mission e autoridade de aprovações.
- `docs/decisions/2026-10-08-local-control-authz.md` — Decisão de autorização local de controle.
- `docs/ARCHITECTURE.md` — Fluxo autoritativo, distinção Current / Direction / Legacy.
- `AGENTS.md` — Regras de baseline, não-regressão e restrições de integridade.

---

## Nota final

Este documento constitui exclusivamente uma **proposta de contrato de confiança e análise arquitetural (PROPOSAL ONLY)**. Não implementa código de produção, não altera contratos públicos existentes, não adiciona tabelas ao banco de dados e não concede permissões reais.

Toda implementação futura permanece estritamente condicionada à aprovação formal de Pedro para as decisões da §14 e à execução faseada através dos slices propostos na §13.

**Estado da tarefa: NEEDS_APPROVAL — proposta corrigida e fundamentada, aguardando revisão do mantenedor e decisão normativa de Pedro.**