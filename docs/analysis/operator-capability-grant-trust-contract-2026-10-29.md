# Contrato de Concessão Explícita de Capabilities a Missions (Operator Capability Grant Trust Contract)

> **Estado:** PROPOSAL ONLY — nenhuma implementação de produção, nenhum contrato público ratificado, nenhuma autorização concedida.
> **Repositório:** `Anakyklos/ouroboros-runtime`
> **Issue:** #166 (P1), epic principal #70 (M1 Local Control Plane)
> **PR:** https://github.com/Anakyklos/ouroboros-runtime/pull/167 (revisão de review 5703514317)
> **Base SHA auditado:** `4a0d6d52075bc665568e126124eb24ec8b8b2ed0` (`main`)
> **HEAD auditado anterior:** `950d2275052e9913c531bc74ae30480e9f969284`
> **Bun (local):** `1.4.2` (CI pin: `1.3.9`)
> **Data:** 2026-10-29
> **Branch:** `docs/166-capability-grant-trust-contract`
> **Classificação de status:** `NEEDS_APPROVAL — proposta corrigida e pronta para nova revisão`

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

**Recomendação arquitetural (PROPOSTA):** Adotar a **Alternativa B com integridade física e controle de concorrência determinístico** — um **ledger durável e fisicamente append-only** de eventos imutáveis de concessão e revogação de capabilities no SQLite local do runtime (`SqliteMissionStore`). A autoridade para qualquer ação decorre exclusivamente da **associação atômica** mantida por um grant individual ativo, validada contra uma fonte confiável independente de limites máximos do autorizador.

**Correções centrais incorporadas nesta revisão (PROPOSTA):**

1. **Integridade referencial real sob `PRAGMA foreign_keys = OFF`:** Constata-se que `cli/src/mission/sqlite-mission-store.ts:291` desativa explicitamente as foreign keys do SQLite (`foreign_keys = OFF`). Portanto, confiar isoladamente em cláusulas `FOREIGN KEY ... ON DELETE RESTRICT` não impede a exclusão acidental de uma Mission com grants. A proposta institui um **trigger de proteção diretamente na tabela `missions`** (`prevent_mission_delete_with_grants`) que aborta fisicamente o comando `DELETE FROM missions` via `RAISE(ABORT, ...)`. Adicionalmente, especificam-se os requisitos mandatórios para uma futura migração que venha a habilitar `foreign_keys = ON`.
2. **Impedimento definitivo da ressurreição de grants após revogação de emissor:** O runtime atual (`LocalControlCredentialStore.provision()`) reutiliza o mesmo `clientId` e limpa `revoked_at` em caso de reprovisionamento. Para impedir que grants históricos invalidados voltem a autorizar ações indevidas após um novo provisionamento do mesmo identificador, a proposta introduz o conceito de **geração de autoridade (`grantorAuthorityEpoch`)**. O grant fica rigidamente atrelado à época de autoridade em que nasceu; se o emissor for revogado ou reprovisionado, grants de épocas anteriores tornam-se definitivamente **caducos / extintos**, eliminando qualquer risco de concessão zumbi sem exigir transações distribuídas (2PC) entre AuthStore e MissionStore.
3. **Remoção de limites de recursos decorativos (Adoção formal da Alternativa A):** Os campos `resourceLimits` (`maxInvocations`, `maxDurationMs`, `budgetUnits`) foram expressamente **removidos do contrato v1 proposto** e adiados para evolução futura. Incluir campos de limite na interface pública sem contadores duráveis atômicos, recuperação transacional em crash e tratamento de concorrência criaria uma perigosa ilusão de segurança (*security theater*). A governança de recursos no v1 permanece delegada à política de orçamento da Mission já existente (`budget_policy`), mantendo o contrato de grants estritamente focado no modelo de acesso fail-closed.
4. **Resolução formal da janela TOCTOU entre Revoke e Handoff:** O ponto autoritativo de linearização é definido na transação atômica SQLite de **reserva durável de submissão** (`submitting`). Se a revogação comitar antes desse ponto, a submissão é abortada no banco sem tocar a rede. Se comitar após a reserva, o runtime tenta cancelar, mas reconhece honestamente a impossibilidade física de transacionar SQLite e rede/processos externos. Invocations em estado incerto decorrentes de crash ou timeout **nunca sofrem replay automático** e dependem unicamente da `ReconciliationAuthority`.
5. **Idempotência e isolamento cross-grantor:** Replay idempotente de `(missionId, grantId)` é estritamente condicionado ao **mesmo emissor original (`grantorClientId`)**. Tentativas de reuso de identificadores por clientes distintos falham com `GRANT_IDENTITY_CONFLICT` sem vazamento de dados.
6. **Compatibilidade nativa com UUIDs reais do runtime:** Validação sintática corrigida para suportar os UUIDs RFC 4122 v4 gerados por `crypto.randomUUID()` em `MissionEngine`.

**Direção de implementação futura em slices isolados (PROPOSTA):**
- **Slice A** — Persistência do ledger append-only (triggers de proteção, isolamento de exclusão sob `foreign_keys = OFF`) e validação de grants por tupla atômica.
- **Slice B** — Endpoints autenticados de concessão e revogação no Local Control Plane com checagem de época de autoridade e isolamento cross-grantor.
- **Slice C** — Planejamento consultivo e aceitação de planos sob revalidação autoritativa atômica.
- **Slice D** — Portões de dispatch, reserva durável de submissão (`submitting`), linearização de handoff e isolamento de incerteza sem replay.

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
- **HEAD auditado anterior:** `950d2275052e9913c531bc74ae30480e9f969284` (commit com review `5703514317`).
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

Toda Mission criada pelo operador via `mission.admit` nasce em estado `CREATED` com `EMPTY_SCOPE`. Sem uma operação de concessão explícita, nenhum passo de plano pode ser validado (`PlanPolicyValidator` rejeita com `CAPABILITY_NOT_AUTHORIZED` ou `EFFECT_NOT_AUTHORIZED`) e nenhuma invocação pode ser despachada.

Adicionalmente, não existe na API pública do daemon (JSON-RPC ou UDS) nenhuma operação para conceder, listar ou revogar capabilities para uma Mission (PROVADO NO CÓDIGO via inspeção em `shared/local-control-*-contract.ts` e `cli/src/daemon/local-control-auth.ts`).

### 2.3 Arquivos, linhas e comportamento atual auditados

| Arquivo | Linhas | Fato auditado no código |
|---|---|---|
| `cli/src/mission/contracts.ts` | 126-136 | `AllowedCapabilityScope` define três listas planas: `capabilityIds`, `allowedEffectClasses`, `allowedRefPrefixes`. |
| `cli/src/mission/contracts.ts` | 140-165 | `ApprovalRequirement` vincula `approvalId` a um `scopeDescriptor` imutável com `effectFingerprint`. |
| `cli/src/mission/contracts.ts` | 400-425 | `CapabilityInvocationDelivery` define estados duráveis: `"not_submitted" \| "submitted" \| "acknowledged" \| "running" \| "failed" \| "uncertain"`. |
| `cli/src/mission/policy.ts` | 100-220, 275-310 | `PlanPolicyValidator` avalia capability, classes de efeito e prefixos de refs como filtros desacoplados. |
| `cli/src/mission/mission-engine.ts` | 85-86 | `MissionEngine.ids` gera identidades usando `crypto.randomUUID()` (UUID RFC 4122 v4 com hífens). |
| `cli/src/mission/mission-engine.ts` | 489-530 | `proposePlan()` valida policy **fora e antes** de `store.withTransaction`. |
| `cli/src/mission/mission-engine.ts` | 562-630 | `acceptPlan()` move revisão para `accepted` **sem revalidar policy** contra o escopo atual da Mission. |
| `cli/src/mission/mission-engine.ts` | 726-890 | `dispatchStep()` valida policy **fora e antes** de `claimInvocation`. |
| `cli/src/capabilities/dispatch-seam.ts` | 410-435 | Executa `markInvocationHandoff(..., { deliveryState: "submitted" })` antes de chamar `connector.invoke(request)`. |
| `cli/src/daemon/local-control-auth.ts` | 20-55, 94-115 | `LocalControlCredentialStore` opera em banco separado (`$XDG_CONFIG_HOME/ouroboros/local-control/`). `provision()` usa `ON CONFLICT(client_id) DO UPDATE ... revoked_at = NULL, created_at = excluded.created_at`. |
| `cli/src/mission/sqlite-mission-store.ts` | 291 | `SqliteMissionStore.initialize()` executa explicitamente `PRAGMA foreign_keys = OFF`. |
| `cli/src/mission/sqlite-mission-store.ts` | 1294-1296 | `deleteMission()` executa `DELETE FROM missions WHERE mission_id = ?`. Sob `foreign_keys = OFF`, FKs declaradas não são aplicadas pelo motor. |
| `cli/src/mission/sqlite-mission-store.ts` | 1918-1945 | `withTransaction()` provê exclusão mútua local via `transactionQueue` e transação `BEGIN/COMMIT/ROLLBACK` no SQLite do runtime. |

---

## 3. Invariantes existentes

**CONTRATO EXISTENTE:**

- `MISSION_CONTRACT_VERSION = 1` (`cli/src/mission/contracts.ts`).
- O planner (LLM ou heurística) não tem autoridade para conceder, solicitar ou alterar escopo de capabilities (`PlanCandidate` não contém campo de autorização).
- `PlanPolicyValidator.validate()` é uma função pura e determinística em relação aos parâmetros fornecidos.
- Uma aprovação de passo (`ApprovalRequirement`) concedida para um efeito específico (comprovada por `effectFingerprint`) não pode ser reutilizada por outro passo com efeito divergente (`APPROVAL_SCOPE_MISMATCH`).
- Autenticação local em `local-control-auth.ts` valida credenciais via tokens HMAC/Bearer e revogação local (`LocalControlCredentialStore`). A presença de credencial confere acesso à rota RPC, mas **não** confere autoridade sobre capabilities do sistema host.
- A atomicidade do SQLite garante integridade ACID estritamente para o arquivo de banco de dados local.

**PROVADO NO CÓDIGO:**

- Toda Mission admitida por cliente externo possui escopo vazio (`EMPTY_SCOPE`).
- Apenas `recordApproval()` no `MissionEngine` pode transicionar um `ApprovalRequirement` de `granted: false` para `granted: true`.
- Identidades de Mission (`missionId`) no runtime são UUIDs v4 com hífens gerados por `crypto.randomUUID()`.
- O banco de dados de Missions opera com `PRAGMA foreign_keys = OFF`.

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

**Veredito (PROPOSTA):** Rejeitada.

### 4.2 Alternativa B (Recomendada e Blindada) — Ledger durável append-only de concessões e revogações com escopo efetivo associado

**Descrição (PROPOSTA):** O daemon mantém duas estruturas relacionais append-only no SQLite: `mission_capability_grants` (para eventos de concessão) e `mission_capability_revocations` (para eventos de revogação). Proíbe-se qualquer mutação destrutiva ou exclusão em cascata, garantindo a integridade via trigger direto em `missions`. Cada grant vincula rigidamente a tupla `(capabilityId, effectClass, allowedRefPrefixes)` ao emissor e à sua época de autoridade (`grantorAuthorityEpoch`). A autorização decorre da validação da tupla em um grant ativo no ledger.

| Critério | Avaliação |
|---|---|
| Segurança e least privilege | **Excelente** — Elimina produto cartesiano; autorização fail-closed; validação contra limites do autorizador. |
| Simplicidade | **Alta** — Sem campos de limites decorativos no v1; padrão append-only consolidado. |
| Consistência transacional | **Excelente** — Eventos de ledger e transições da Mission residem na mesma transação atômica SQLite. |
| Auditoria e provenance | **Máxima** — Histórico imutável de emissão, geração de credencial e revogações explícitas; protegido por trigger de bloqueio e triggers append-only. |
| Revogação granular | **Excelente** — Revogação direcionada por `grantId`, idempotente, fail-closed para novas operações; sem ressuscitação pós-reprovisionamento. |
| Linearização de concorrência | **Formalizada** — Ponto de linearização na transação durável para `submitting`; isolamento de efeitos externos sem replay de `uncertain`. |
| Isolamento de replay | **Estrito** — Replay condicionado estritamente à identidade do emissor original (`grantorClientId`). |

**Veredito (PROPOSTA):** **Recomendada**.

### 4.3 Alternativa C — Autoridade de policy externa ou registro independente de autorizações

**Descrição (PROPOSTA de análise):** Delegação da decisão de autorização para um daemon externo (ex.: OPA, Spire ou serviço HTTP de governança).

| Critério | Avaliação |
|---|---|
| Segurança e least privilege | Alta em tese, mas adiciona novo vetor de rede e novo boundary de confiança não auditado. |
| Complexidade operacional | **Inaceitável para M1** — Requer dependência de rede, latência externa, processo adicional e sincronização cross-process. |
| Consistência transacional | **Fraca** — Quebra a atomicidade SQLite; impossível coordenar 2PC sem complexidade desmedida. |

**Veredito (PROPOSTA):** Rejeitada para M1.

---

## 5. Arquitetura recomendada (Alternativa B blindada)

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
        ├─► 1. Autenticação e Entitlement Prévios (precedem leitura e escrita)
        ├─► 2. Captura da Época de Autoridade do Emissor (authorityEpoch do AuthStore)
        ├─► 3. Validação contra fonte independente de limites máximos (operator policy)
        ├─► 4. Verificação de Replay Seguro (rejeita se grantId já existe sob outro grantor)
        ├─► 5. Validação da tupla atômica (capabilityId ∈ limites, effectClass ∈ contract, refs ∈ limites)
        ├─► 6. Cálculo do fingerprint canônico (sha256 determinístico)
        │
        ▼
Transação SQLite Atômica no MissionStore (withTransaction):
        ├─► INSERT INTO mission_capability_grants (...) [registro fisicamente imutável com authorityEpoch]
        ├─► Atualiza updatedAt da Mission
        └─► COMMIT (dispara publicação de mutações aos observadores)
```

### 5.2 Preservação estrita da tupla de grant (eliminação do produto cartesiano)

A autorização **nunca é avaliada contra listas globais unificadas**. Toda autorização preserva a tupla indissociável:

$$\text{Grant} = \langle \text{grantId}, \text{capabilityId}, \text{effectClass}, \text{allowedRefPrefixes}, \text{grantorId}, \text{authorityEpoch}, \text{validity} \rangle$$

Um passo de plano `P` com requisito de capability `C`, classe de efeito `E` e conjunto de referências de entrada $R = \{r_1, r_2, \dots, r_k\}$ só é autorizado se existir **um mesmo grant ativo** $G$ tal que:
1. $C \in G.\text{capabilityIds}$
2. $E \in G.\text{allowedEffectClasses}$
3. $\forall r \in R, \exists p \in G.\text{allowedRefPrefixes} \text{ tal que } r \text{ inicia com } p$
4. $G$ não está expirado nem revogado no momento da verificação.
5. O emissor $G.\text{grantorId}$ permanece com autoridade válida e seu epoch atual coincide com $G.\text{authorityEpoch}$.

### 5.3 Exemplo adversarial: Produto Cartesiano A × B

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

Um passo proposto com `capabilityRequirement: fs.read_file`, `effectClass: READ` e `inputRefs: ["db://financial/production/credentials.key"]` passaria sob listas desacopladas porque cada atributo encontra correspondência em alguma lista.

**Resultado no modelo corrigido (PROPOSTA):**
O validador checa contra cada grant isolado:
- No Grant A: a ref `db://...` falha no prefixo `storage://...`.
- No Grant B: a capability `fs.read_file` não pertence ao grant.
- Nenhum grant cobre a tupla conjuntamente $\rightarrow$ **Bloqueado deterministicamente com `CAPABILITY_REF_OUT_OF_GRANT_BOUNDS`**.

### 5.4 Fonte confiável e independente de limites máximos do grantor

**PROPOSTA + DECISÃO PENDENTE:** Um cliente autenticado não pode conceder autorizações que excedam seus próprios privilégios máximos provisionados.

Regra mandatória: O `CapabilityGrantService` valida que:
$$G.\text{capabilityIds} \subseteq \text{Limit}.\text{maxCapabilities}$$
$$G.\text{allowedEffectClasses} \subseteq \text{Limit}.\text{maxEffectClasses}$$
$$G.\text{allowedRefPrefixes} \subseteq \text{Limit}.\text{maxRefPrefixes}$$
Qualquer discrepância resulta em rejeição imediata com `CAPABILITY_EXCEEDS_GRANTOR_LIMITS`.

---

## 6. Modelo de autoridade e composição determinística

### 6.1 Identidade, autoridade e ciclo de vida do emissor (grantor)

- **Quem pode conceder:** Cliente autenticado no Local Control Plane portador do scope específico `mission.grant_capabilities`.
- **Identidade imutável no ledger:** Toda concessão armazena o `grantorClientId`, a `grantorCredentialVersion` (hash do token ativo no momento do despacho) e o `grantorAuthorityEpoch` (época de provisionamento do cliente).
- **Impossibilidade de forja:** Campos de autoridade não são aceitos no corpo da requisição RPC; são extraídos diretamente do objeto `LocalControlAuthenticatedClient` validado pelo daemon Fastify/UDS.

### 6.2 Escopo de cada concessão (tupla associada autoritativa)

```typescript
export interface CapabilityGrantRecord {
  readonly grantId: string;
  readonly missionId: string;
  readonly grantorClientId: string;
  readonly grantorCredentialVersion: string;
  readonly grantorAuthorityEpoch: number; // Identificador/timestamp da geração de autoridade no AuthStore
  readonly capabilityIds: readonly string[];
  readonly allowedEffectClasses: readonly EffectClass[];
  readonly allowedRefPrefixes: readonly string[];
  readonly issuedAt: string;        // ISO 8601 UTC
  readonly expiresAt?: string;       // ISO 8601 UTC ou undefined (sem expiração temporal)
  readonly contractVersion: number;  // CAPABILITY_GRANT_CONTRACT_VERSION
  readonly fingerprint: string;      // sha256 canônico
  readonly createdAt: string;
}
```

> [!NOTE]
> **Decisão de Simplificação e Segurança (Alternativa A adotada):**
> Os campos `resourceLimits` (`maxInvocations`, `maxDurationMs`, `budgetUnits`) foram expressamente **removidos do contrato v1 proposto** e formalmente adiados para uma revisão futura (v2). A inclusão de campos de limite decorativos sem implementação durável de reserva, recuperação pós-crash e contadores atômicos criaria uma falsa sensação de segurança (*security theater*). O controle de orçamento e recursos permanece sob a governança existente da Mission (`budget_policy` em `missions`).

### 6.3 Regra determinística de composição e anti-escalada

1. **União de tuplas, não de campos:** Ter múltiplos grants ativos para uma mesma Mission significa que o executor pode executar ações cobertas pelo Grant A OU pelo Grant B de forma disjunta.
2. **Redução e Revogação:** A autorização cessa para uma tupla assim que for registrado um evento de revogação para o respectivo `grantId`.
3. **Isolamento de autoridade:** Concessões adicionadas por operadores distintos operam de forma isolada e nunca criam permissões cruzadas.

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
  readonly missionId: string; // UUID v4 gerado pelo runtime (com hífens)
  readonly grantId: string;   // Identificador de idempotência escopado ao emissor
  readonly capabilityIds: string[];
  readonly allowedEffectClasses: EffectClass[];
  readonly allowedRefPrefixes: string[];
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
GRANT_CONFLICT                  // Mesmo grantId e mesmo emissor, mas payload divergente
GRANT_IDENTITY_CONFLICT         // grantId já pertence a OUTRO emissor (cross-grantor violation)
REVOCATION_CONFLICT             // Mesmo revocationId e mesmo emissor, mas motivo divergente
REVOCATION_IDENTITY_CONFLICT    // revocationId já pertence a OUTRO emissor
REVOCATION_NOT_AUTHORIZED       // Emissor não tem autoridade para revogar este grant
GRANT_NOT_FOUND
GRANT_ALREADY_REVOKED
AUTHORITY_REVOKED               // Emissor do grant foi revogado
AUTHORITY_SUPERSEDED           // Grant pertence a época de autoridade extinta/reprovisionada
AUTHORITY_UNAVAILABLE           // Auth store indisponível / inacessível (fail-closed)
CAPABILITY_REF_OUT_OF_GRANT_BOUNDS
REVOKED_BEFORE_SUBMISSION       // Revogação comitou antes da reserva de submissão
```

### 7.7 Validação sintática de identidades e compatibilidade com UUIDs reais

Para garantir total compatibilidade com os identificadores efetivamente produzidos pelo runtime via `crypto.randomUUID()` em `cli/src/mission/mission-engine.ts:85-86`:

- **Validação de `missionId`:** Deve aceitar estritamente o formato de UUID RFC 4122 v4 com hífens gerado pelo runtime (padrão regex `/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/`) ou identificadores seguros delimitados compostos por `[0-9a-zA-Z_-]` com comprimento entre 1 e 128 caracteres. São expressamente rejeitados caracteres de controle, espaços, barras, null-bytes ou sequências de escape.
- **Validação de `grantId` e `revocationId`:** Identificadores estáveis compostos por `[0-9a-zA-Z_-]` com comprimento entre 1 e 128 caracteres (compatíveis tanto com UUIDs quanto com slugs fornecidos por clientes).
- **Limites de array e payload:** `capabilityIds` $\le 64$ itens (cada ID $\le 128$ chars); `allowedRefPrefixes` $\le 64$ itens (cada $\le 256$ chars); `reason` de revogação $\le 1024$ chars; tamanho total do payload JSON $\le 65.536$ bytes.

---

## 8. Persistência, ledger auditável, idempotência e recovery

### 8.1 Schema do ledger append-only e integridade sob `foreign_keys = OFF`

No runtime atual, `cli/src/mission/sqlite-mission-store.ts:291` executa `PRAGMA foreign_keys = OFF`. Sob essa configuração nativa, qualquer declaração `FOREIGN KEY ... ON DELETE RESTRICT` é silenciosamente ignorada pelo SQLite no comando `DELETE FROM missions`.

Para sanar este fato comprovado sem quebrar o banco atual nem presumir migrações não aprovadas:

1. **Garantia Física por Trigger na Tabela `missions`:** Cria-se o trigger `prevent_mission_delete_with_grants` diretamente na tabela `missions`. Esse trigger é ativado pelo SQLite **mesmo com `foreign_keys = OFF`**, abortando qualquer exclusão direta caso existam concessões históricas para a Mission.
2. **Triggers Append-Only nas Tabelas de Grants e Revocações:** Impossibilitam qualquer `UPDATE` ou `DELETE` direto nas tabelas do ledger.
3. **DDL Proposto:**

```sql
-- 1. Registro imutável de eventos de concessão (Grant Ledger)
CREATE TABLE IF NOT EXISTS mission_capability_grants (
  grant_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  grantor_client_id TEXT NOT NULL,
  grantor_credential_version TEXT NOT NULL,
  grantor_authority_epoch INTEGER NOT NULL,  -- Timestamp/Epoch do ciclo de autoridade no AuthStore
  capability_ids TEXT NOT NULL,              -- JSON array de strings
  allowed_effect_classes TEXT NOT NULL,      -- JSON array de strings
  allowed_ref_prefixes TEXT NOT NULL,        -- JSON array de strings
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  contract_version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,                 -- sha256 canônico do payload
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, grant_id)
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
  fingerprint TEXT NOT NULL,                 -- sha256 canônico do evento de revogação
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, revocation_id)
);

CREATE INDEX IF NOT EXISTS idx_grants_mission_created
  ON mission_capability_grants(mission_id, created_at);

CREATE INDEX IF NOT EXISTS idx_revocations_target
  ON mission_capability_revocations(mission_id, target_grant_id);

-- 3. Triggers para garantir integridade física independente de PRAGMA foreign_keys
CREATE TRIGGER IF NOT EXISTS prevent_mission_delete_with_grants
BEFORE DELETE ON missions
BEGIN
  SELECT RAISE(ABORT, 'cannot delete mission: active or historical capability grants exist in ledger')
  WHERE EXISTS (
    SELECT 1 FROM mission_capability_grants WHERE mission_id = OLD.mission_id
  );
END;

CREATE TRIGGER IF NOT EXISTS prevent_grant_update BEFORE UPDATE ON mission_capability_grants
BEGIN
  SELECT RAISE(ABORT, 'mission_capability_grants is strictly append-only: updates are forbidden');
END;

CREATE TRIGGER IF NOT EXISTS prevent_grant_delete BEFORE DELETE ON mission_capability_grants
BEGIN
  SELECT RAISE(ABORT, 'mission_capability_grants is strictly append-only: deletions are forbidden');
END;

CREATE TRIGGER IF NOT EXISTS prevent_revocation_update BEFORE UPDATE ON mission_capability_revocations
BEGIN
  SELECT RAISE(ABORT, 'mission_capability_revocations is strictly append-only: updates are forbidden');
END;

CREATE TRIGGER IF NOT EXISTS prevent_revocation_delete BEFORE DELETE ON mission_capability_revocations
BEGIN
  SELECT RAISE(ABORT, 'mission_capability_revocations is strictly append-only: deletions are forbidden');
END;
```

**Requisitos para Habilitação Futura de `PRAGMA foreign_keys = ON`:**
Caso uma evolução arquitetural futura decida ativar `foreign_keys = ON`:
- Deve ser precedida por uma auditoria completa via `PRAGMA foreign_key_check` em todos os bancos de dados de produção existentes.
- Deve incluir uma migração transacional que saneie registros órfãos pré-existentes.
- Deve comprovar, em suíte de testes SQLite sob WAL mode, que a ativação não gera deadlocks com as transações da fila `transactionQueue`.
- O contrato proposto funciona de forma **100% segura e comprovada tanto sob `foreign_keys = OFF` quanto sob `foreign_keys = ON`**.

### 8.2 Identidade estável e ordenação determinística

- `grant_id`: Chave primária estável fornecida na emissão ou derivada de forma unívoca, garantindo idempotência e referência imutável.
- `revocation_id`: Identificador estável do evento de revogação.
- **Ordenação determinística:** Os eventos são ordenados sequencialmente por `created_at` (ISO 8601 UTC) com critério de desempate por `rowid`/chave primária no SQLite.

### 8.3 Idempotência vinculada estritamente à identidade do emissor original

O runtime rejeita categoricamente que um cliente B reutilize o identificador de grant emitido por um cliente A:

1. **Precedência de Autenticação e Entitlement:** Antes de realizar qualquer leitura ou verificação no ledger de grants, o daemon valida a autenticidade da credencial do chamador e a presença do escopo `mission.grant_capabilities`. Chamadas anônimas ou desautorizadas falham imediatamente com HTTP 401/403 sem consultar o banco.
2. **Replay pelo Emissor Original (`currentClientId === existingGrant.grantorClientId`):**
   - Se o payload/fingerprint for idêntico: Retorna sucesso com os dados da concessão existente (`HTTP 200 / ok: true`), sem gerar nova inserção no ledger (idempotência perfeita).
   - Se o payload divergir: Rejeita com `GRANT_CONFLICT` (mesmo emissor tentando redefinir uma concessão existente).
3. **Tentativa de Replay por Outro Cliente (`currentClientId !== existingGrant.grantorClientId`):**
   - Se o cliente B submeter uma solicitação com um `grantId` já registrado pelo cliente A: O daemon rejeita sumariamente com **`GRANT_IDENTITY_CONFLICT`**.
   - **Garantia anti-vazamento:** A resposta de erro não divulga os dados, capacidades ou fingerprint do grant pertencente ao cliente A.

### 8.4 Épocas de autoridade: Prevenção contra ressuscitação de grants pós-reprovisionamento

No `LocalControlCredentialStore`, quando um cliente é revogado e posteriormente reprovisionado via `provision(clientId, ...)`, o código executa `ON CONFLICT(client_id) DO UPDATE SET revoked_at = NULL, created_at = excluded.created_at`. Isso reativa o `clientId` com um novo timestamp `created_at`.

Para impedir que concessões antigas emitidas antes da revogação voltem a autorizar ações:

1. **Registro da Época na Emissão:** Ao emitir um grant, o serviço grava `grantor_authority_epoch` = `client.created_at` (timestamp da época de autoridade corrente no AuthStore).
2. **Diferenciação Estrita entre Estados de Emissor:**
   - **Rotação Legítima de Credenciais:** O token do operador é renovado durante o mesmo ciclo de autoridade (`revoked_at` nunca foi acionado; `authorityEpoch` permanece o mesmo). Grants emitidos continuam ativos e válidos.
   - **Revogação do Emissor:** O operador é revogado no AuthStore (`revoked_at !== null`). A autoridade daquela época é extinta. Todos os grants daquele emissor tornam-se inativos.
   - **Reprovisionamento com o mesmo `clientId` (Novo Epoch):** O cliente é reprovisionado, gerando um novo `created_at` ($E_2 > E_1$).
   - **Regra de Invalidação Permanente:** Na redução de grants, o runtime verifica:
     $$\text{isGrantActive} \iff (\text{grant.grantorAuthorityEpoch} == \text{client.currentAuthorityEpoch}) \land (\text{client.revokedAt} == \text{null})$$
     Grants emitidos no epoch $E_1$ falham na checagem ($E_1 \neq E_2$) e são considerados **permanentemente caducos (`AUTHORITY_SUPERSEDED`)**. Eles **NUNCA voltam à vida**.
   - **Grants Emitidos Após o Reprovisionamento:** Recebem o epoch $E_2$ e operam normalmente dentro do seu novo ciclo legítimo.

### 8.5 Transações locais no MissionStore vs. Fronteira com o AuthStore

- **Atomicidade local:** Toda escrita no ledger append-only de grants/revogações ocorre estritamente dentro de `store.withTransaction()`, que serializa operações via `transactionQueue` e comita atomicamente no SQLite local do `MissionStore`.
- **Fronteira com o AuthStore (Sem 2PC cross-DB):** O `LocalControlCredentialStore` reside em um arquivo SQLite separado (`local-control`). Não existe transação distribuída (Two-Phase Commit) entre o banco de credenciais e o banco de Missions.
- **Semântica Fail-Closed:** A revalidação da credencial e da época do emissor é realizada antes de iniciar a transação no `MissionStore`. Se o `AuthStore` estiver inacessível, lento, travado ou corrompido, a operação é rejeitada com **`AUTHORITY_UNAVAILABLE`**. Nenhuma transação é aberta e nenhum grant é gravado.

---

## 9. Revogação, concorrência e limites de atomicidade

### 9.1 Auditoria do comportamento atual de main (janelas de corrida identificadas)

A auditoria do código atual de `main` revela quatro janelas de concorrência:
1. **Em `proposePlan()` (`cli/src/mission/mission-engine.ts:489-530`):** `this.policy.validate()` roda na linha 506, antes de `withTransaction` na linha 515. Revogação concorrente permite propor plano baseado em grant recém-revogado.
2. **Em `acceptPlan()` (`cli/src/mission/mission-engine.ts:562-630`):** Não há revalidação de policy antes de mover a revisão para `accepted`. Revogação durante a proposta é ignorada na aceitação.
3. **Em `dispatchStep()` (`cli/src/mission/mission-engine.ts:726-890`):** `this.policy.validate()` roda na linha 778, fora e antes de `withTransaction(claimInvocation)` na linha 884.
4. **No Handoff do Agendador (`cli/src/capabilities/dispatch-seam.ts:410-435`):** A invocação gravada como `not_submitted` é despachada. Entre a verificação e a chamada externa, pode ocorrer revogação (janela TOCTOU).

### 9.2 O ponto autoritativo de linearização e a transição durável de reserva (`submitting`)

Para fechar definitivamente a janela TOCTOU sem assumir falsas premissas físicas:

1. **Definição do Ponto de Linearização:**
   O ponto autoritativo de linearização é a **transação SQLite atômica de reserva de submissão** executada imediatamente antes de invocar o conector externo. Dentro dessa transação:
   - O runtime verifica se o `grantId` responsável pela invocação continua ativo, não revogado e com época válida no ledger.
   - Se ativo: comita duravelmente a transição de `delivery.state = "submitting"` (reserva durável) e registra o timestamp de envio.
   - Se revogado: aborta a transição e marca `delivery.state = "failed"` com `error = "REVOKED_BEFORE_SUBMISSION"`.
2. **Comportamento Pós-Linearização:**
   Assim que a transação de reserva comita `submitting`, a autorização de envio foi formalmente consumida. O runtime passa a chamada ao conector físico.
3. **Limitações Físicas da Rede e Subprocessos:**
   O runtime reconhece explicitamente que **não é possível transacionar o SQLite local e uma chamada externa de rede**. Se uma revogação comitar milissegundos após o commit de reserva (`submitting`), o runtime tentará acionar o cancelamento (`cancellation.requested = true`), mas **NÃO PODE GARANTIR** que o efeito físico não ocorrerá na ponta externa.

### 9.3 Matriz adversarial de concorrência e interleavings

A tabela a seguir define a semântica rigorosa para todas as interleavings possíveis entre uma operação de revogação (`Revoke`) e o ciclo de despacho de efeito:

| Interleaving | Ponto Exato de Commit do Revoke no SQLite | Comportamento do Runtime | Garantia Real Oferecida | Efeito Externo Submetido? |
|---|---|---|---|:---:|
| **1. Revoke pré-proposta** | Antes de `proposePlan.withTransaction` | Revalidação do Gate 1 falha na transação | Proposta rejeitada com `CAPABILITY_NOT_AUTHORIZED` | **Não** |
| **2. Revoke pré-aceitação** | Durante proposta ou antes de `acceptPlan` | Revalidação do Gate 2 falha na transação de aceitação | Aceitação rejeitada; Mission não move para `READY` | **Não** |
| **3. Revoke pré-claim** | Antes de `dispatchStep.withTransaction(claim)` | Gate 3 constata grant revogado antes do claim | Invocação não é claimada; falha com `DispatchRejectedError` | **Não** |
| **4. Revoke pré-reserva** | Após claim (`not_submitted`), mas ANTES do commit da reserva de submissão | Gate 4 na transação de reserva detecta revoke no ledger | Reserva falha; invocação marcada como `failed` (`REVOKED_BEFORE_SUBMISSION`) | **Não** |
| **5. Revoke pós-reserva (em voo)** | APÓS o commit da reserva (`submitting`), durante ou logo após a chamada física ao conector | Revogação comita no ledger; runtime marca `cancellation.requested = true` | Efeito já foi autorizado no ponto de linearização; cancelamento assíncrono emitido ao conector sem garantia física de reversão | **Indeterminado / Em voo** |
| **6. Crash durante submissão** | Daemon cai com invocação em estado `submitting` | No boot, recovery classifica entrega como `uncertain`; **zero replay automático** | Resolução estrita via `ReconciliationAuthority` determinística | **Indeterminado (Auditado)** |

### 9.4 Reconhecimento da impossibilidade de atomicidade SQLite + efeito externo

> [!IMPORTANT]
> **Princípio de Realidade Operacional:**
> Uma transação no SQLite é puramente local ao arquivo de banco de dados do host. **Ela NÃO confere e NUNCA poderá conferir atomicidade a um efeito executado no mundo real** (como comandos shell, mutações de arquivos em disco, requisições de rede ou transações remotas de API).

Qualquer alegação de que um rollback no SQLite desfaz um efeito externo executado é arquiteturalmente falsa. Uma vez que o payload cruza a fronteira do processo do daemon, a atomicidade transacional local encerra-se. A segurança depende de delimitar o ciclo de vida dos efeitos e proibir presunções ingênuas de sucesso ou retry.

### 9.5 Ciclo de vida dos efeitos e ausência de replay automático

Os efeitos de capabilities seguem o ciclo de estados estrito:

```text
       ┌──────────────┐
       │   PREPARED   │ (Gravado no SQLite; delivery.state = "not_submitted")
       └──────┬───────┘
              │ Gate 4: Transação de Reserva Durável (Ponto de Linearização)
              ▼
       ┌──────────────┐
       │  SUBMITTING  │ (delivery.state = "submitting"; autorização de envio consumida)
       └──────┬───────┘
              │ Chamada física ao conector (rede / socket / processo)
              ▼
       ┌──────────────┐
       │  SUBMITTED   │ (delivery.state = "running" / "acknowledged")
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

1. **Efeitos Preparados (`prepared`):** Invocação gravada no SQLite com `delivery.state = "not_submitted"`. Se revogada antes da reserva de submissão, a entrega é cancelada de forma fail-closed sem submissão externa.
2. **Reserva Durável (`submitting`):** Ponto de linearização transacional onde a autorização é consumida antes de acionar a rede.
3. **Efeitos Submetidos (`submitted`):** Invocação transmitida. Revogação posterior marca intenção de cancelamento (`cancellation.requested = true`), mas não altera o fato da transmissão.
4. **Efeitos Incertos (`uncertain`):** Crash, timeout ou falha de conexão durante o estado `submitting` ou antes do ack. **É ESTRITAMENTE PROIBIDO REPLAY AUTOMÁTICO.** A resolução só pode ocorrer via `ReconciliationAuthority` determinística.
5. **Efeitos Confirmados (`confirmed`):** Efeitos com evidência definitiva registrada (`completed` ou `failed`). Uma revogação de grant posterior **nunca reverte, não apaga e não invalida a evidência do efeito executado**. O passado permanece imutável e auditável.

---

## 10. Compatibilidade e migração com Missions legadas

### 10.1 Os cinco cenários de compatibilidade e proveniência

| Cenário | Condição do Ambiente / Dados | Comportamento para Ações Futuras (Proposta / Aceitação / Dispatch) | Preservação de Histórico e Evidências |
|---|---|---|---|
| **1. Escopo histórico com autoridade verificável** | Ledger de grants presente, íntegro e correlacionado com o histórico da Mission. | **Permitido.** Escopo ativo é derivado deterministicamente pela redução dos eventos ativos no ledger. | Integralmente preservado. |
| **2. Escopo histórico sem proveniência comprovada** | Mission pré-existente (v1) criada antes do ledger, contendo `allowedCapabilityScope` no banco, mas zero eventos no ledger de grants. | **FAIL-CLOSED (Bloqueado).** O escopo persistido antigo **NÃO** é tratado como autorização ativa e **NÃO** faz união com novos grants. Novas propostas, aceitações e dispatches são rejeitados até concessão explícita em ledger. | **Totalmente preservado.** Invocations passadas, revisões e evidências permanecem imutáveis para auditoria. |
| **3. Ledger ausente em instalação nova** | Instalação limpa do runtime do zero. | **Permitido.** Tabelas são criadas limpas. Toda nova Mission nasce com escopo vazio (`EMPTY_SCOPE`). Concessões ocorrem exclusivamente via ledger. | N/A (banco novo). |
| **4. Ledger ausente após migração** | Banco de dados existente atualizado via migration; tabelas de ledger criadas, porém vazias de registros históricos. | **FAIL-CLOSED (Bloqueado).** Aplica-se a regra do Cenário 2. As Missions migradas mantêm histórico forense preservado, mas nenhuma nova capability é executada sem concessão legítima por operador. | Totalmente preservado. Nenhuma deleção de dados. |
| **5. Ledger corrompido / checksum mismatch** | Registros de grants ou revogações com integridade violada, JSON inválido ou divergência de fingerprint. | **FAIL-CLOSED IMEDIATO.** A Mission afetada é congelada para novas operações. Erro estruturado de auditoria é logado. Nenhuma inferência permissiva é tolerada. | Evidências existentes intactas. Operação bloqueada. |

### 10.2 Princípio de não-conversão implícita em grants sintéticos

> [!WARNING]
> É terminantemente vedado ao código de migração criar "grants sintéticos", "grants mágicos" ou inferir intenção de autorizadores do passado. Qualquer concessão de autoridade deve derivar de uma transação explícita, assinada ou submetida por um operador autenticado e auditável.

### 10.3 Preservação integral do histórico e evidências passadas

Nenhuma política fail-closed para novas operações afetará invocations pretéritas com status `completed` ou `failed`, atribuições de evidência em `evidence_refs`, atestados de verificação de critérios ou histórico de revisões.

---

## 11. Threat model e análise de segurança

### 11.1 Matriz de ameaças e controles

| Ameaça / Vetor | Impacto Potencial | Controle Arquitetural Proposto | Teste Obrigatório |
|---|---|---|---|
| **Escalação por produto cartesiano A × B** | Execução de capabilities com referências de outros grants | Preservação estrita da tupla no grant; validação atômica correlacionada (§5.2) | `test_grant_cartesian_product_adversarial` |
| **Operador concedendo além dos limites** | Elevação de privilégio do autorizador | Validação obrigatória contra fonte confiável de limites máximos (§5.4) | `test_grantor_limit_enforcement` |
| **Ressuscitação de grants pós-reprovisionamento** | Concessões antigas de emissor revogado voltam a autorizar ações | Validação de época de autoridade (`grantorAuthorityEpoch`); invalidação definitiva de épocas passadas (§8.4) | `test_grantor_revoke_and_reprovision_does_not_resurrect_grants` |
| **Destruição de ledger via deleção de Mission sob FK OFF** | Perda de evidência forense de autorizações passadas | Trigger `prevent_mission_delete_with_grants` na tabela `missions`; aborta fisicamente o comando DELETE (§8.1) | `test_prevent_mission_delete_with_grants_trigger_under_fk_off` |
| **Reuso de `grantId` por outro cliente (cross-grantor)** | Acesso ou reaproveitamento de grant de outro emissor | Vínculo estrito de idempotência ao `grantorClientId` original; erro `GRANT_IDENTITY_CONFLICT` (§8.3) | `test_cross_grantor_replay_isolation` |
| **Mutação destrutiva do ledger no SQLite** | Modificação de registros imutáveis de grants | Triggers SQLite `prevent_grant_update/delete` que abortam qualquer escrita destrutiva (§8.1) | `test_grant_immutability_triggers` |
| **Corrida TOCTOU entre Revoke e Handoff** | Disparo de efeito externo após revogação confirmada | Ponto de linearização na transação de reserva (`submitting`); isolamento de efeitos em voo (§9.2–9.3) | `test_handoff_linearization_race_before_reservation` |
| **Replay após queda do daemon** | Re-execução indevida de efeito incerto | Proibição de replay automático; isolamento do estado `uncertain` (§9.5) | `test_uncertain_delivery_no_replay` |
| **Bypass de validação via UUID malformado** | Rejeição de IDs reais ou injeção de parâmetros | Parser compatível com UUIDs RFC 4122 v4 reais gerados por `crypto.randomUUID()` (§7.7) | `test_real_uuid_mission_id_lifecycle` |
| **Indisponibilidade do AuthStore** | Assunção permissiva sem checagem de credencial | Sem 2PC cross-DB; fail-closed imediato com `AUTHORITY_UNAVAILABLE` (§8.5) | `test_auth_store_unavailable_fail_closed` |
| **Vazamento de tokens em projeções** | Exposição de credenciais e segredos | Projeções sanitizadas em `durable-projection.ts`; sem segredos no wire | `test_sanitized_projections` |

### 11.2 Defesa contra prompt injection vs mera sanitização de texto

1. **Separação Estrutural de Dados vs. Instruções:** As diretivas do planner (`PlanCandidate`) são tratadas exclusivamente como **dados consultivos passivos**, jamais como código executável ou concessão de autoridade.
2. **Impotência de Autoridade do Modelo:** O modelo de IA não tem acesso a chaves criptográficas, não emite tokens de autorização, não invoca rotas de grant e não pode alterar o ledger do SQLite.
3. **Validação Determinística Compilada:** O `PlanPolicyValidator` e o `MissionEngine` são escritos em código TypeScript compilado e determinístico. Mesmo que o modelo seja 100% comprometido por injeção adversária e declare que tem autoridade ilimitada, o validador verificará o ledger relacional no SQLite e rejeitará sumariamente a tentativa.

---

## 12. Matriz de testes projetados (futuros)

| Identificador do Teste | Escopo / Cenário Validado | Critério de Aceite Estrito |
|---|---|---|
| `test_prevent_mission_delete_with_grants_trigger_under_fk_off` | Executa `DELETE FROM missions` sob `PRAGMA foreign_keys = OFF` para Mission que possui grants. | Trigger na tabela `missions` aborta a operação via `RAISE(ABORT)`; Mission e grants permanecem intactos. |
| `test_grant_immutability_triggers` | Tenta executar `UPDATE` ou `DELETE` diretamente nas tabelas `mission_capability_grants` e `mission_capability_revocations`. | Triggers disparam `RAISE(ABORT)` e operação é cancelada no SQLite. |
| `test_grantor_revoke_and_reprovision_does_not_resurrect_grants` | Emite grant no epoch $E_1$, revoga emissor, reprovisiona emissor no epoch $E_2$. Tenta despachar passo autorizado pelo grant antigo. | Rejeitado deterministicamente com `AUTHORITY_SUPERSEDED`; grant antigo nunca ressuscita. |
| `test_cross_grantor_replay_isolation` | Cliente B tenta submeter grant com `grantId` pertencente ao Cliente A. | Rejeitado com `GRANT_IDENTITY_CONFLICT` sem vazar dados do grant de A. |
| `test_real_uuid_mission_id_lifecycle` | Emissão de grant, revoke e list utilizando UUIDs v4 com hífens gerados por `crypto.randomUUID()`. | Validação sintática aceita os UUIDs reais do runtime e rejeita malformados. |
| `test_handoff_linearization_race_before_reservation` | Revoke comita imediatamente antes da transação de reserva (`submitting`). | Gate 4 bloqueia a reserva; invocação marca `failed` com `REVOKED_BEFORE_SUBMISSION`; zero chamadas ao conector. |
| `test_handoff_linearization_race_after_reservation` | Revoke comita após a transação de reserva (`submitting`), durante a chamada externa. | Runtime registra cancelamento, mas não assume cancelamento físico; efeito não sofre replay automático. |
| `test_uncertain_delivery_no_replay` | Simula falha de entrega externa deixando estado `uncertain`. Emite revogação e dispara tick do scheduler. | Nenhum replay automático executado. Resolução unicamente via autoridade. |
| `test_legacy_mission_fail_closed` | Carrega banco com Mission v1 (sem ledger). Tenta propor e despachar novo step. | Bloqueio imediato fail-closed; histórico e evidências passadas intactos. |
| `test_auth_store_unavailable_fail_closed` | Simula falha ou travamento no `LocalControlCredentialStore` durante a concessão. | Operação rejeitada com `AUTHORITY_UNAVAILABLE`; zero escritas no `MissionStore`. |

---

## 13. Decomposição futura (slices independentes de implementação)

### Slice A — Persistência do ledger append-only e validação por tupla correlacionada
- **Objetivo:** Adicionar tabelas `mission_capability_grants` e `mission_capability_revocations` no `SqliteMissionStore`, trigger de proteção `prevent_mission_delete_with_grants` em `missions`, triggers de imutabilidade, método de redução determinística de estado e validação por tupla indissociável no `PlanPolicyValidator`.
- **Superfície pública:** Nenhuma (sem RPC ou CLI).
- **Critério de parada:** Se a validação por tupla quebrar a compatibilidade de interfaces sem migração segura, pausar.

### Slice B — Operações administrativas de Concessão e Revogação no Local Control Plane
- **Objetivo:** Implementar os endpoints JSON-RPC/UDS `mission.grant_capabilities`, `mission.revoke_capability_grant` e `mission.list_capability_grants` no daemon, protegidos pelo escopo `mission.grant_capabilities`, isolamento cross-grantor e vinculação com a época de autoridade do emissor.
- **Superfície pública:** Rotas internas versionadas no controle local.
- **Critério de parada:** Rejeitar qualquer concessão se o emissor não possuir limites explicitamente configurados ou tentar usurpar `grantId` alheio.

### Slice C — Revalidação autoritativa nos portões de planejamento e aceitação
- **Objetivo:** Adaptar `proposePlan()` e `acceptPlan()` no `MissionEngine` para fechar as janelas de corrida 1 e 2 (§9.1), garantindo revalidação atômica antes de persistir propostas ou aceitar planos.
- **Superfície pública:** Nenhuma alteração de assinatura.
- **Critério de parada:** Qualquer plano sem cobertura ativa deve ser rejeitado sem alterar estado da Mission.

### Slice D — Portões de dispatch, linearização de reserva de submissão e incerteza
- **Objetivo:** Implementar o Gate 3 (dentro de `claimInvocation`), a transação atômica de reserva de submissão (`submitting`) no Gate 4, e barreira de incerteza sem replay automático.
- **Superfície pública:** Nenhuma.
- **Critério de parada:** Garantir que nenhum efeito incerto sofra retry automático e nenhum efeito com revoke pré-reserva seja despachado.

---

## 14. Decisões que exigem aprovação de Pedro (DECISÃO PENDENTE)

As seguintes questões arquiteturais e normativas permanecem em aberto e **dependem de aprovação explícita de Pedro**:

1. **Nomenclatura do escopo de autorização para concessão:** Adotar `mission.grant_capabilities`, `capability.grant` ou integrar em um escopo administrativo mais amplo? (Recomendação: `mission.grant_capabilities` dedicado).
2. **Localização da fonte de limites máximos do grantor:** Optar por arquivo de configuração estático (`$OUROBOROS_DATA_DIR/security/operator-limits.json`) ou coluna adicional provisionada na tabela `local_control_clients`? (Recomendação para M1: arquivo local de governança).
3. **Política de expiração default:** Permitir grants sem data de expiração (`expiresAt` opcional, revogável a qualquer tempo) ou exigir prazo de validade máximo mandatório (ex.: leases de 24 horas)?
4. **Política diante de revogação de credencial de operador:** Desativar grants emitidos para novos efeitos futuros e extinguir a época de autoridade (fail-closed, recomendado) vs. cancelamento em cascata de planos aceitos.
5. **Escopo para leitura de grants (`mission.list_capability_grants`):** Permitir leitura com o escopo existente `mission.read` ou criar escopo específico para evitar enumeração de capabilities por clientes de telemetria básica?
6. **Formato final de migração de Missions legadas:** Confirmar o tratamento fail-closed estrito sem criação de grants sintéticos para dados históricos.
7. **Governança concorrente:** Admitir revogação cruzada (Operador B revogar grant emitido pelo Operador A) se ambos possuírem autoridade de governança, ou restringir a revogação ao emissor original e `daemon.admin`?
8. **Ratificação da remoção de limites de recursos no v1 (Alternativa A):** Confirmar o adiamento de quotas e orçamentos dinâmicos por grant para o contrato v2, mantendo a governança no v1 via `budget_policy` da Mission.

---

## 15. Evidências e referências ao código auditado

**PROVADO NO CÓDIGO:**
- `cli/src/daemon/local-control-admission.ts:25-35, 153` — Criação de Mission com `EMPTY_SCOPE`.
- `cli/src/mission/contracts.ts:126-136` — Representação plana de `AllowedCapabilityScope`.
- `cli/src/mission/contracts.ts:400-425` — Estados duráveis de `CapabilityInvocationDelivery`.
- `cli/src/mission/mission-engine.ts:85-86` — Geração de `missionId` via `crypto.randomUUID()`.
- `cli/src/mission/policy.ts:100-220, 275-310` — Validação desacoplada de capability e referências em `PlanPolicyValidator`.
- `cli/src/mission/mission-engine.ts:489-530` — `proposePlan` valida policy fora da transação.
- `cli/src/mission/mission-engine.ts:562-630` — `acceptPlan` não revalida policy contra escopo atual.
- `cli/src/mission/mission-engine.ts:726-890` — `dispatchStep` valida policy fora de `claimInvocation`.
- `cli/src/capabilities/dispatch-seam.ts:410-435` — `markInvocationHandoff(..., { deliveryState: "submitted" })` antes de `connector.invoke`.
- `cli/src/daemon/local-control-auth.ts:20-55, 94-115` — `LocalControlCredentialStore` em banco separado; reprovisionamento com `revoked_at = NULL, created_at = excluded.created_at`.
- `cli/src/mission/sqlite-mission-store.ts:291` — `initialize()` executa `PRAGMA foreign_keys = OFF`.
- `cli/src/mission/sqlite-mission-store.ts:1294-1296` — `deleteMission()` executa `DELETE FROM missions WHERE mission_id = ?`.
- `cli/src/mission/sqlite-mission-store.ts:1918-1945` — Fila em memória `transactionQueue` e semântica de `withTransaction`.
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

**Estado da tarefa: NEEDS_APPROVAL — proposta corrigida e fundamentada, aguardando revisão do mantenedor e ratificação normativa de Pedro.**
