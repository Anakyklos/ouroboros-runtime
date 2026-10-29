# Contrato de Concessão Explícita de Capabilities a Missions (Operator Capability Grant Trust Contract)

> **Estado:** PROPOSAL ONLY — nenhuma implementação de produção, nenhum contrato público ratificado, nenhuma autorização concedida.
> **Repositório:** `Anakyklos/ouroboros-runtime`
> **Issue:** #166 (P1), epic principal #70 (M1 Local Control Plane)
> **Base SHA auditado:** `4a0d6d52075bc665568e126124eb24ec8b8b2ed0` (`main`, após `git pull --ff-only origin main`)
> **Bun (local):** `1.4.2` (CI pin: `1.3.9`)
> **Data:** 2026-10-29
> **Branch:** `docs/166-capability-grant-trust-contract`
> **PR planejada:** `docs(trust): propose explicit capability grant contract (#166)`
> **Classificação de status:** `NEEDS_APPROVAL — aguardando decisão normativa sobre o contrato de grants`

---

## Legenda de classificação

Toda afirmação neste documento carrega uma das seguintes classificações:

- **PROVADO NO CÓDIGO** — verificável no código-fonte atual da base auditada.
- **CONTRATO EXISTENTE** — definido por contrato/documento aprovado e presente no repositório.
- **PROPOSTA** — comportamento ou contrato proposto por este documento; não implementado.
- **HIPÓTESE** — possibilidade não verificada; requer POC/benchmark/evidência.
- **DECISÃO PENDENTE** — requer aprovação explícita de Pedro/mantenedor.

---

## 1. Executive decision summary

**Recomendação (PROPOSTA):** adotar a **Alternativa B** — um **ledger durável de concessões e revogações** de capabilities, com o escopo efetivo da Mission derivado deterministicamente a partir desse ledger, validado contra uma fonte confiável e independente de limites máximos do autorizador.

**Justificativa resumida (PROPOSTA):**

- A base atual já prova o padrão de idempotência/ledger em `mission_admissions` (PROVADO NO CÓDIGO, `cli/src/daemon/local-control-admission.ts`), o que torna a Alternativa B a mais consistente com a arquitetura real, sem introduzir infraestrutura nova.
- A Alternativa A (atualização direta do escopo) não preserva provenance/identidade de concessão nem revogação granular; torna a autorização indistinguível de uma mutação genérica de Mission e enfraquece auditoria e recovery.
- A Alternativa C (autoridade de policy externa/registro independente) é desproporcional para M1: introduz um segundo sistema de autoridade e um novo boundary de confiança antes de existir evidência de necessidade; conflita com a direção de daemon headless como autoridade local (#70).

**Direção preferencial de slices futuros (PROPOSTA):**

- Slice A — persistência e policy de grants, sem superfície pública.
- Slice B — operação autenticada e auditável de concessão/revogação.
- Slice C — planejamento consultivo e aceitação sob escopo autorizado.
- Slice D — integração de execução, condicionada aos gates anteriores e aprovação específica.

**Invariantes centrais preservadas (CONTRATO EXISTENTE):**

1. `MissionIntent != Mission`; a Mission nasce dentro do Ouroboros.
2. Planning/LLM é advisory; código/policy autoriza effects.
3. Um scope de autenticação **não pode, sozinho**, autorizar qualquer capability existente (DECISÃO APROVADA em `docs/decisions/2026-10-08-local-control-authz.md`).
4. `daemon.admin` e `mission.create` **não** concedem capabilities implicitamente.
5. Capability grant ≠ step approval ≠ plan acceptance ≠ dispatch authorization.

**Decisões que exigem aprovação de Pedro (DECISÃO PENDENTE):** ver §14.

**Estado final:** `NEEDS_APPROVAL`. Nenhuma implementação iniciada.

---

## 2. Baseline factual auditado

### 2.1 Referência Git

- Base SHA: `4a0d6d52075bc665568e126124eb24ec8b8b2ed0` (PROVADO NO CÓDIGO via `git rev-parse HEAD` em `main` após pull).
- Branch de trabalho: `docs/166-capability-grant-trust-contract`.
- Estado inicial de `main`: limpo após stash/checkout (mudanças não relacionadas preservadas em stash).

### 2.2 Lacuna reproduzida (PROVADO NO CÓDIGO)

Hoje, a admissão pública de MissionIntent cria Missions com escopo **vazio**:

```text
cli/src/daemon/local-control-admission.ts:25
const EMPTY_SCOPE: AllowedCapabilityScope = {
  capabilityIds: [],
  allowedEffectClasses: [],
  allowedRefPrefixes: [],
};
...
cli/src/daemon/local-control-admission.ts:153
allowedCapabilityScope: EMPTY_SCOPE,
```

Consequência (PROVADO NO CÓDIGO): toda Mission criada por operador via `mission.admit` é `CREATED + EMPTY_SCOPE`. Sem uma operação de concessão, nenhuma capability pode ser planejada (`PlanPolicyValidator` rejeita `CAPABILITY_NOT_AUTHORIZED`) nem despachada.

Não existe, em nenhuma superfície pública, operação para conceder capabilities (PROVADO NO CÓDIGO via busca por `grant` em `shared/` e `cli/src/commands/`).

### 2.3 Arquivos e linhas auditados

| Arquivo | Linhas relevantes | Fato |
|---|---|---|
| `cli/src/mission/contracts.ts` | 126-136 | `AllowedCapabilityScope` (capabilityIds, allowedEffectClasses, allowedRefPrefixes) |
| `cli/src/mission/contracts.ts` | 140-160 | `ApprovalRequirement` com `scopeDescriptor` imutável e `effectFingerprint` |
| `cli/src/mission/contracts.ts` | 230-260 | `Mission` inclui `allowedCapabilityScope`, `approvalRequirements` |
| `cli/src/mission/policy.ts` | 100-115 | `PlanPolicyValidator` |
| `cli/src/mission/policy.ts` | 140-155 | `CAPABILITY_NOT_AUTHORIZED` quando capability fora do scope |
| `cli/src/mission/policy.ts` | 155-175 | `EFFECT_NOT_AUTHORIZED` |
| `cli/src/mission/mission-engine.ts` | 424-485 | `createMission()` persiste scope fornecido |
| `cli/src/mission/mission-engine.ts` | 489-550 | `proposePlan()` valida policy antes de persistir |
| `cli/src/mission/mission-engine.ts` | 562-665 | `acceptPlan()` cria requirements não concedidos |
| `cli/src/mission/mission-engine.ts` | 671-700 | `recordApproval()` único caminho de grant de approval |
| `cli/src/mission/mission-engine.ts` | 726-900 | `dispatchStep()` gates incluindo revalidação de policy |
| `cli/src/daemon/local-control-admission.ts` | 25-35, 153 | `EMPTY_SCOPE` no admission |
| `cli/src/daemon/local-control-auth.ts` | 2-20, 338-365 | scopes `mission.read/create/control`, `daemon.admin`; `requiredLocalControlScope()` |
| `shared/local-control-auth-contract.ts` | 1-10 | `LOCAL_CONTROL_AUTH_SCOPES` |
| `cli/src/mission/sqlite-mission-store.ts` | 293-315 | schema `missions` com `allowed_capability_scope` |
| `cli/src/mission/sqlite-mission-store.ts` | 1918-1945 | `withTransaction` (BEGIN/COMMIT/ROLLBACK + fila) |
| `cli/src/capabilities/registry.ts` | 1-60 | Capability Registry, discovery ≠ authorization |
| `cli/src/daemon/durable-projection.ts` | 40-55 | `projectMission()` não expõe scope |
| `docs/decisions/2026-10-08-local-control-authz.md` | completo | decisão de authz local aprovada |

### 2.4 Evidência de testes relevantes (PROVADO NO CÓDIGO)

- `cli/src/daemon/local-control-admission.test.ts` — idempotência, conflito, isolamento por cliente, injeção de authority rejeitada.
- `cli/src/mission/mission-engine.test.ts` — dispatch gates, replay protection, approval scope mismatch.
- `cli/src/mission/sqlite-mission-store.test.ts` — transações, recovery, restart, mutation publishing após commit.
- `cli/src/daemon/local-control-auth.test.ts` / `.e2e.test.ts` — 401/403, rotação, revogação, revalidação WS 500ms.

---

## 3. Invariantes existentes

**CONTRATO EXISTENTE:**

- `MISSION_CONTRACT_VERSION = 1` (`cli/src/mission/contracts.ts`).
- `AllowedCapabilityScope` é a única representação autoritativa de escopo de capability de uma Mission.
- O planner não pode alterar `allowedCapabilityScope` (não está em `PlanCandidate` nem em `PlanStep`).
- `PlanPolicyValidator.validate()` rejeita capability fora do scope (`CAPABILITY_NOT_AUTHORIZED`) e effect class não autorizado (`EFFECT_NOT_AUTHORIZED`).
- `dispatchStep()` revalida o plano aceito contra policy atual antes de criar invocation.
- `mission_admissions` garante idempotência por `(clientId, requestId)` com fingerprint de payload.
- `withTransaction` garante atomicidade multi-registro e publicação de eventos somente após commit.
- `daemon.admin`/`mission.create` são scopes de acesso ao controle local, não autorização de capabilities.

**PROVADO NO CÓDIGO:**

- Admission cria Missions com `EMPTY_SCOPE`.
- Nenhuma capability pode ser autorizada sem scope não-vazio.
- `recordApproval()` é o único caminho que seta `granted = true` em `ApprovalRequirement`.

---

## 4. Alternativas comparadas

### 4.1 Alternativa A — Atualizar diretamente o escopo da Mission mediante operação autenticada

**Descrição (PROPOSTA de análise):** uma operação autenticada muta `Mission.allowedCapabilityScope` (union) dentro de uma transação, com auditoria via `updatedAt`/mutation events.

| Critério | Avaliação |
|---|---|
| Segurança / least privilege | Médio — depende de validação do grantor, mas mutação direta mistura autorização com estado da Mission |
| Simplicidade | Alta — reutiliza `updateMission` |
| Consistência transacional | Alta — uma transação |
| Auditoria | Baixa/Média — sem identidade de concessão, sem histórico de revogação, sem fingerprint de grant |
| Revogação | Fraca — revogar exige recomputar diff sem histórico |
| Recovery após crash | Média — estado materializado persiste, mas sem ledger para reconstruir provenance |
| Compatibilidade Mission v1 | Alta — apenas muta campo existente |
| Custo operacional | Baixo |
| Risco de ampliação de autoridade | Alto — concessão e revogação indistinguíveis; sem identidade idempotente de grant; combinável silenciosamente |

**Veredito (PROPOSTA):** insuficiente para "auditável e revogável". Rejeitada como direção principal, mas pode ser a **materialização efetiva** derivada do ledger (cache), não a autoridade.

### 4.2 Alternativa B — Ledger durável de concessões e revogações, escopo efetivo derivado deterministicamente

**Descrição (PROPOSTA):** introduzir tabela `mission_capability_grants` (nome candidato) com registros imutáveis de grant/revoke; `Mission.allowedCapabilityScope` passa a ser uma **projeção materializada** (cache) derivada do ledger ativo; toda mutação de autorização cria um registro de ledger.

| Critério | Avaliação |
|---|---|
| Segurança / least privilege | Alta — cada grant validado contra limites independentes do grantor; revogação granular |
| Simplicidade | Média — padrão já existe (`mission_admissions`) |
| Consistência transacional | Alta — ledger + cache + Mission em uma transação |
| Auditoria | Alta — histórico imutável, provenance, fingerprint |
| Revogação | Alta — revoke explícito, fail-closed, sem undo de efeitos |
| Recovery após crash | Alta — reconstrução do escopo a partir do ledger |
| Compatibilidade Mission v1 | Alta — campo existente permanece como cache; schema bump opcional |
| Custo operacional | Baixo/Médio — uma tabela adicional |
| Risco de ampliação de autoridade | Baixo — composição governada, sem wildcard, validação por grantor |

**Veredito (PROPOSTA):** recomendada.

### 4.3 Alternativa C — Autoridade de policy externa ou registro independente de autorizações

**Descrição (PROPOSTA de análise):** um serviço/registro externo (ou módulo separado) decide e fornece autorizações; Ouroboros consulta-o.

| Critério | Avaliação |
|---|---|
| Segurança / least privilege | Potencialmente alta, mas cria segundo trust boundary |
| Simplicidade | Baixa — novo serviço, protocolo, deploy |
| Consistência transacional | Baixa/Média — coordenação cross-process |
| Auditoria | Alta (se bem feito) |
| Revogação | Depende do externo |
| Recovery após crash | Depende de disponibilidade externa |
| Compatibilidade Mission v1 | Média |
| Custo operacional | Alto |
| Risco de ampliação de autoridade | Médio — risco de implícito "externo = confiável" |

**Veredito (PROPOSTA):** desproporcional para M1. A direção #70 estabelece o daemon headless como autoridade local. Não há evidência de necessidade (HIPÓTESE não verificada) de autoridade externa. Rejeitada neste estágio, com reavaliação futura se multi-daemon/multi-host for necessário (HIPÓTESE).

### 4.4 Comparação resumida

| Alternativa | Auditoria | Revogação | Recovery | Complexidade | Risco de escalada |
|---|---|---|---|---|---|
| A | Baixa | Fraca | Média | Baixa | Alto |
| B | Alta | Alta | Alta | Média | Baixo |
| C | Alta | Depende | Depende | Alta | Médio |

**Decisão proposta (PROPOSTA):** B.

---

## 5. Arquitetura recomendada (Alternativa B)

### 5.1 Visão geral

```text
Operator (autenticado, scope mission.grant — nome candidato)
        ↓
 RPC local_control.grant_capabilities (novo, versionado)
        ↓
 CapabilityGrantService (novo, daemon-side)
        ↓ valida grantor contra fonte confiável independente
        ↓ valida payload (allowlist, limites)
        ↓ transação SQLite:
            - insere registro imutável em mission_capability_grants
            - recompute allowedCapabilityScope (cache) a partir do ledger ativo
            - updateMission(...) atomicamente
            - publica mutation após commit
        ↓
 Mission (scope efetivo derivado)
        ↓
 Planner advisory → PlanPolicyValidator (scope atual)
        ↓
 Dispatch (revalidação de scope atual)
```

**PROPOSTA:** o ledger é a autoridade; `Mission.allowedCapabilityScope` é cache materializado, sempre recomputável.

### 5.2 Fonte confiável independente de limites máximos do grantor

**PROPOSTA + DECISÃO PENDENTE:** os direitos máximos de concessão do autorizador **não** podem ser auto-declarados pelo cliente nem derivados de `mission.create`/`daemon.admin`. Fontes candidatas (a decidir):

1. **Arquivo de policy do operador** (recomendado para M1): arquivo JSON assinado/propriedade do operador em `OUROBOROS_DATA_DIR`, mode `0600`, definindo `maxCapabilityIds`, `maxEffectClasses`, `maxRefPrefixes` por `clientId`. Lido pelo daemon no boot; alteração exige restart ou operação `daemon.admin` explícita.
2. **Extensão da tabela `local_control_clients`**: coluna `grant_limits_json` provisionada via CLI `auth provision ... --grant-limits <file>`. Mais integrado, mas muda schema de auth (DECISÃO PENDENTE).
3. **Configuração de daemon** (`OUROBOROS_GRANT_POLICY_FILE`).

**HIPÓTESE:** para multi-host, uma autoridade externa (Alternativa C) pode ser necessária; não verificado.

**Invariantes (PROPOSTA):**

- Um grantor nunca pode conceder capability fora de seu `max*` (fail-closed).
- `daemon.admin` permite gerenciar a policy de limites, mas **não** concede capabilities a Missions.
- `mission.create` permite admitir Missions, mas **não** concede capabilities.
- Rotação/revogação de credencial invalida grants futuros; grants já emitidos permanecem auditáveis mas **não** autorizam novos efeitos após revalidação (ver §9).

---

## 6. Modelo de autoridade

### 6.1 Identidade do autorizador

**PROPOSTA:**

- **Quem pode conceder:** um cliente autenticado com scope dedicado `mission.grant_capabilities` (nome candidato; DECISÃO PENDENTE) **e** com limites máximos provisionados na fonte confiável independente.
- **Identidade autoritativa:** `clientId` + `credentialVersion` (hash do token) derivados do contexto autenticado pelo daemon (PROVADO NO CÓDIGO: `LocalControlAuthenticatedClient`).
- **Verificação:** o daemon revalida a credencial a cada operação (`isClientStillAuthorized`) e antes de cada efeito (§9); identidade nunca é confiada a campos do payload.
- **Provisionamento:** via CLI `auth provision <client> mission.grant_capabilities,...` + limites; armazenado no registry local (PROVADO NO CÓDIGO: `LocalControlCredentialStore.provision`).
- **Revogação:** `auth revoke <client>` invalida credencial; grants emitidos permanecem no ledger (auditoria) mas não autorizam novos efeitos.
- **Evitar implícito:** `requiredLocalControlScope()` deve mapear a nova operação **apenas** para o novo scope; `daemon.admin` e `mission.create` não satisfazem `mission.grant_capabilities` (PROVADO NO CÓDIGO: padrão de mapeamento em `local-control-auth.ts:338-365`).

### 6.2 Escopo de cada concessão

**PROPOSTA:** cada grant vincula explicitamente:

| Campo | Tipo | Regra |
|---|---|---|
| `grantId` | string | Identidade estável da concessão (idempotência) |
| `missionId` | string | Mission alvo (obrigatório) |
| `grantorClientId` | string | Derivado do contexto autenticado |
| `grantorCredentialVersion` | string | Hash do token no momento da emissão |
| `capabilityIds` | string[] | Allowlist explícita; sem wildcards; subset dos limites do grantor |
| `allowedEffectClasses` | EffectClass[] | Subset dos limites do grantor |
| `allowedRefPrefixes` | string[] | Prefixos de refs; subset dos limites do grantor |
| `resourceLimits` | objeto opcional | `maxInvocations`, `maxDurationMs`, `budgetUnits` (quando aplicável) |
| `issuedAt` | string (ISO) | Timestamp do daemon |
| `expiresAt` | string (ISO) opcional | Expiração; ausência = sem expiração, mas revogável |
| `contractVersion` | number | Versão do contrato de grant |
| `fingerprint` | string (sha256) | Fingerprint canônico do payload |
| `revokedAt` | string opcional | Timestamp de revogação |
| `revocationReason` | string opcional | Sanitizado |
| `revokedBy` | string opcional | clientId do revogador |

**Regras (PROPOSTA):**

- Sem wildcards irrestritos (`"*"`, `""`) em `capabilityIds` ou `allowedRefPrefixes`.
- Sem permissões globais implícitas: ausência de grant = escopo vazio (fail-closed).
- `capabilityIds` devem ser capacidades registradas no `CapabilityRegistry` (PROVADO NO CÓDIGO: resolver existente) — grant de capability desconhecida é rejeitado.
- `allowedEffectClasses` deve ser subset das classes da capability concedida (validação cruzada).
- `allowedRefPrefixes` deve ser subset dos limites do grantor e dos prefixos da capability.

### 6.3 Composição de permissões

**PROPOSTA:**

- **Escopo efetivo** = união determinística dos grants ativos (não revogados, não expirados) para a Mission, intersectado com os limites de cada grantor (já validados na emissão).
- **Adicionar autorização:** novo grant ativo adiciona capacidades ao escopo efetivo (union).
- **Reduzir autorização:** não existe operação de "reduzir" parcial independente; redução ocorre por revogação de grant (remove sua contribuição) ou por concessão de um grant mais restrito que substitui? **PROPOSTA:** não permitir substituição implícita; redução = revoke + novo grant. Evita ambiguidade.
- **Revogar autorização:** remove a contribuição do grant; escopo efetivo recomputado.
- **Anti-escalada:** 
  - Nenhum grant pode "herdar" capacidades de outro grant.
  - A união não cria um novo grant mais amplo; não existe operação de merge.
  - Revogar um grant não pode ser compensado por outro grant sem revalidação.
  - O escopo efetivo nunca excede a união dos grants ativos validados; nunca excede os limites do grantor de cada grant.
  - Concessões parciais de múltiplos grantors podem se compor por union, mas cada grant é auditável e revogável individualmente; a autoridade coletiva é a soma de autoridades individuais legitimamente provisionadas, não uma amplificação.

**DECISÃO PENDENTE:** confirmar se a composição deve ser union (recomendado) ou se deve haver um "teto de Mission" (capability ceiling) definido na admissão. A admissão atual não define ceiling (EMPTY_SCOPE). Propomos **não** introduzir ceiling implícito; grants explícitos são o único caminho.

---

## 7. Contrato tipado proposto (PROPOSTA)

### 7.1 Operações candidatas

```text
mission.grant_capabilities   (RPC local_control.grant)
mission.revoke_capability_grant
mission.list_capability_grants   (leitura, scope mission.read?)
```

**DECISÃO PENDENTE:** nomes finais e se leitura de grants requer `mission.read` ou novo scope.

### 7.2 Request/Response (grant)

```typescript
// PROPOSTA — não é contrato ratificado
export const CAPABILITY_GRANT_CONTRACT_VERSION = 1 as const;
export const CAPABILITY_GRANT_OPERATION = "mission.grant_capabilities" as const;

export interface CapabilityGrantRequest {
  protocolVersion: typeof CAPABILITY_GRANT_PROTOCOL_VERSION;
  operation: typeof CAPABILITY_GRANT_OPERATION;
  missionId: string;
  grantId: string;                 // idempotency key (escopado a mission+grantor)
  capabilityIds: string[];
  allowedEffectClasses: EffectClass[];
  allowedRefPrefixes: string[];
  resourceLimits?: {
    maxInvocations?: number;
    maxDurationMs?: number;
    budgetUnits?: number;
  };
  expiresAt?: string;              // ISO, opcional
  // NÃO incluir grantor, grantedBy, scope de auth — derivados do contexto
}

export type CapabilityGrantResponse =
  | { ok: false; code: CapabilityGrantFailureCode; message: string }
  | {
      ok: true;
      protocolVersion: typeof CAPABILITY_GRANT_PROTOCOL_VERSION;
      operation: typeof CAPABILITY_GRANT_OPERATION;
      data: CapabilityGrantProjection;
    };
```

**Allowlist de campos (PROPOSTA):** exatamente os campos acima. Qualquer campo extra → `INVALID_REQUEST`. Campos de autoridade (`grantor`, `grantedBy`, `source`, `allowedCapabilityScope`) rejeitados (padrão de `local-control-admission.ts`).

### 7.3 Request/Response (revoke)

```typescript
export interface CapabilityGrantRevokeRequest {
  protocolVersion: number;
  operation: "mission.revoke_capability_grant";
  missionId: string;
  grantId: string;
  reason: string;                  // sanitizado, obrigatório
}
```

### 7.4 Projeção pública sanitizada

```typescript
export interface CapabilityGrantProjection {
  grantId: string;
  missionId: string;
  capabilityIds: string[];
  allowedEffectClasses: EffectClass[];
  allowedRefPrefixes: string[];
  issuedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  // grantorClientId pode ser exposto? DECISÃO PENDENTE (sanitização)
}
```

**PROPOSTA:** não expor `grantorCredentialVersion` nem fingerprint na projeção pública (evita vazamento). Disponível em auditoria interna.

### 7.5 Códigos de erro (PROPOSTA)

```text
INVALID_REQUEST
PROTOCOL_VERSION_REQUIRED / UNSUPPORTED
INVALID_ID
INVALID_PAYLOAD
MISSION_NOT_FOUND
MISSION_TERMINAL
CAPABILITY_UNKNOWN
CAPABILITY_NOT_GRANTABLE   // fora dos limites do grantor
EFFECT_CLASS_MISMATCH
REF_PREFIX_NOT_ALLOWED
GRANT_CONFLICT              // mesmo grantId, fingerprint diferente
GRANT_EXPIRED
GRANT_NOT_FOUND
GRANT_ALREADY_REVOKED
AUTHORITY_UNAVAILABLE
GRANT_FAILED
```

### 7.6 Limites de tamanho (PROPOSTA, a calibrar)

- `missionId`, `grantId`: ≤ 256 chars, não vazio, sem segredo.
- `capabilityIds`: ≤ 64 itens, cada ≤ 128 chars.
- `allowedRefPrefixes`: ≤ 64 itens, cada ≤ 256 chars.
- `reason` (revoke): ≤ 1024 chars.
- Payload total: ≤ 65536 chars (consistente com admission).

### 7.7 Compatibilidade de versão

- `CAPABILITY_GRANT_CONTRACT_VERSION = 1`. Bump em breaking change.
- Missions antigas (schema v1) continuam válidas com `allowedCapabilityScope` materializado; grants são aditivos.
- Se o ledger estiver ausente (dados pré-grant), escopo efetivo = valor persistido em `allowedCapabilityScope` (compatibilidade), mas marcado como `legacy_unaudited`? **PROPOSTA:** não reescrever; novos grants adicionam ao existente. Migração não destrutiva.

---

## 8. Persistência, idempotência e recovery

### 8.1 Registro durável do grant

**PROPOSTA:** tabela `mission_capability_grants`:

```sql
CREATE TABLE IF NOT EXISTS mission_capability_grants (
  grant_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  grantor_client_id TEXT NOT NULL,
  grantor_credential_version TEXT NOT NULL,
  capability_ids TEXT NOT NULL DEFAULT '[]',
  allowed_effect_classes TEXT NOT NULL DEFAULT '[]',
  allowed_ref_prefixes TEXT NOT NULL DEFAULT '[]',
  resource_limits TEXT NOT NULL DEFAULT '{}',
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  contract_version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  revoked_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, grant_id)
);
CREATE INDEX IF NOT EXISTS idx_grants_mission ON mission_capability_grants(mission_id);
CREATE INDEX IF NOT EXISTS idx_grants_grantor ON mission_capability_grants(grantor_client_id);
```

**Nota:** `grant_id` escopado a `mission_id` (PK composta), consistente com idempotência por Mission. Se grantor-global idempotency for necessário, DECISÃO PENDENTE.

### 8.2 Provenance e versão

- Cada registro armazena grantor, credential version, issuedAt, contractVersion, fingerprint.
- `Mission.allowedCapabilityScope` (cache) é recomputado a partir dos grants ativos.

### 8.3 Identidade idempotente e fingerprint canônico

- `grantId` é a chave idempotente (fornecida pelo cliente ou derivada? **PROPOSTA:** fornecida pelo cliente, validada; o daemon pode derivar se ausente? DECISÃO PENDENTE. Preferimos exigir do cliente para idempotência explícita, como `requestId` na admission).
- Fingerprint = sha256 de serialização canônica (stable key order) do payload normalizado (sem campos de autoridade).
- Replay: mesmo `(missionId, grantId)` + mesmo fingerprint → retorna grant existente (idempotente).
- Conflito: mesmo `(missionId, grantId)` + fingerprint diferente → `GRANT_CONFLICT`, sem mutação.

### 8.4 Replay seguro e conflito determinístico

- Padrão de `LocalControlAdmissionService.admit()` (PROVADO NO CÓDIGO): transação com `getGrant` → se existe, compara fingerprint → replay ou conflito.
- Race: unique constraint → fallback para leitura e comparação (mesmo padrão).

### 8.5 Transações SQLite

- Grant: `BEGIN` → insert grant → recompute scope → `updateMission` → `COMMIT` → publish mutations. Rollback em falha.
- Revoke: `BEGIN` → update grant (revokedAt) → recompute scope → `updateMission` → `COMMIT`.
- Publicação de eventos somente após commit (PROVADO NO CÓDIGO: `withTransaction`).

### 8.6 Comportamento após crash

- Se crash antes do commit → rollback completo; nenhum grant parcial; escopo inalterado.
- Se crash após commit → ledger e cache consistentes (ambos no mesmo commit).
- Restart: recompute cache a partir do ledger para cada Mission carregada (ou validar cache; se divergência, ledger vence e cache é corrigido). Fail-closed: se ledger ilegível/corrupto, escopo = vazio para aquela Mission + log interno; não conceder capabilities implícitas.

### 8.7 Rotação e revogação de credenciais

- Rotação invalida `credentialVersion`; grants emitidos com versão antiga permanecem no ledger.
- Revalidação antes de novo efeito: se grantor não está mais autorizado, o grant **não** autoriza novos efeitos (fail-closed). **PROPOSTA:** grant permanece no ledger como histórico, mas é tratado como inativo para autorização futura se grantor revogado. **DECISÃO PENDENTE:** confirmar se revogação de grantor deve revogar automaticamente seus grants ou apenas desativá-los para novos efeitos. Recomendamos: desativar para novos efeitos, preservar evidência.

### 8.8 Compatibilidade com dados anteriores

- Missions pré-grant mantêm `allowedCapabilityScope` persistido; tratado como cache legado.
- Novos grants adicionam (union) ao escopo legado.
- Sem migração destrutiva.

---

## 9. Revogação, concorrência e recovery

### 9.1 Comportamento por estágio

| # | Estágio | Comportamento ao revogar |
|---|---|---|
| 1 | Antes da geração do plano | Plano não pode usar capabilities revogadas; `proposePlan` valida policy contra scope atual → `CAPABILITY_NOT_AUTHORIZED` |
| 2 | Durante a geração do plano | Planner é advisory; não tem autoridade. Revalidação final em `proposePlan` |
| 3 | Depois de proposta, antes da aceitação | `acceptPlan` deve revalidar policy contra scope atual antes de aceitar; se revogado → rejeitar aceitação |
| 4 | Depois da aceitação, antes do dispatch | `dispatchStep` gate de scope → `DispatchRejectedError` |
| 5 | Durante a preparação de um efeito | Revalidação de scope antes de submeter; se revogado → bloquear, não submeter |
| 6 | Depois de submissão externa com resultado incerto | Sem replay automático; reconciliação via `ReconciliationAuthority` apenas; revogação não cancela automaticamente efeito remoto |
| 7 | Depois de efeito confirmado | Evidência preservada; revogação não desfaz efeito externo; Mission pode ser verificada com evidência existente |

### 9.2 Revalidação autoritativa antes de cada novo efeito

**PROPOSTA:** `dispatchStep()` e qualquer caminho de submissão de efeito devem ler o scope efetivo **atual** do ledger (não cache stale) antes de criar/submeter invocation. Cache pode ser usado apenas se validado contra ledger na mesma transação.

### 9.3 Revogação fail-closed para operações ainda não autorizadas

- Revogação remove contribuição do grant; operações subsequentes não veem a capability.
- Operações já em voo (invocation criada mas não submetida) são bloqueadas antes da submissão.

### 9.4 Preservação de evidência de efeitos confirmados

- Revogação não apaga invocations, evidências ou verificações.
- `isInvocationTerminal` e evidência permanecem.

### 9.5 Impossibilidade de o planner reativar autorização

- Planner não tem endpoint de grant; não pode setar scope.
- `PlanCandidate` não contém campos de scope/grant.
- Policy rejeita qualquer tentativa de mutação de scope (não há campo para mutar).

### 9.6 Consistência entre transação, estado da Mission e scheduler

- Revoke em transação atualiza ledger + cache + Mission; scheduler lê scope atual.
- Concorrência revoke vs dispatch: serialização via `withTransaction` queue (PROVADO NO CÓDIGO). Dispatch revalida dentro da transação antes de claim invocation.

### 9.7 Tratamento de concorrência revoke vs dispatch

**PROPOSTA:** ordenação determinística:

1. Dispatch adquire transação, revalida scope, claim invocation, commit.
2. Revoke adquire transação, marca grant, recompute scope, commit.
3. Se revoke commitou antes de dispatch revalidar → dispatch vê scope revogado → rejeita.
4. Se dispatch commitou antes de revoke → invocation existe; revoke não cancela automaticamente; reconciliação/owner verification decidem.
5. Nunca há "meio-termo": transação garante atomicidade.

### 9.8 Efeito submetido/incerto

- Revogação não gera replay automático de efeitos incertos.
- Reconciliação apenas via `ReconciliationAuthority` (PROVADO NO CÓDIGO: `recordReconciledInvocationResult`).
- Preservar `hasUncertainDelivery` e não re-submeter.

---

## 10. Threat model

| Ataque | Vetor | Impacto | Controle | Teste esperado |
|---|---|---|---|---|
| Cliente com `mission.create` tenta conceder capabilities | Payload `mission.grant_capabilities` sem scope dedicado | Escalação de privilégio | `requiredLocalControlScope` retorna null/403; operação negada | 403 + zero mutação |
| Operador excedendo seus direitos | Grant de capability fora dos limites | Escalação | Validação contra fonte independente → `CAPABILITY_NOT_GRANTABLE` | Teste de limite |
| Modelo fabricando campos de autorização | PlanCandidate com `allowedCapabilityScope` (não existe) ou grant fields | Bypass | Contrato não aceita esses campos; policy rejeita desconhecidos | Teste de schema/allowlist |
| Planner alterando capability/effect class | PlanStep com capability fora do scope | Execução não autorizada | Policy `CAPABILITY_NOT_AUTHORIZED`/`EFFECT_NOT_AUTHORIZED` | policy.test.ts |
| Aprovação reaproveitada em outro efeito | Step referencia approvalId com fingerprint diferente | Reuso de grant | `APPROVAL_SCOPE_MISMATCH` | policy.test.ts |
| Revogação concorrente com dispatch | Race revoke/dispatch | Efeito não autorizado | Serialização + revalidação | Concurrency test |
| Replay após restart | Re-dispatch de step | Efeito duplicado | `InvocationConflictError` + ledger | Restart test |
| Rotação/revogação de credenciais | Grantor revogado | Autorização stale | Revalidação fail-closed | Auth e2e |
| References maliciosas | `inputRefs` com prefixos não autorizados | Acesso a dados | Policy `INPUT_INCOMPATIBLE`/`STORAGE_ACCESS_DENIED` | policy.test.ts |
| Grants expirados | `expiresAt` passado | Uso de grant vencido | Filtro de ativos na derivação | Expiry test |
| Capability removida/indisponível | Registry não resolve | Dispatch de capability inexistente | `CAPABILITY_UNKNOWN`/`DispatchRejectedError` | Registry test |
| Corrupção parcial do ledger | Linhas inválidas | Autorização implícita | Fail-closed: escopo vazio + log | Corruption test |
| Prompt injection | Texto em intent/constraints | Injeção de instrução | Sanitização + planner advisory | Sanitize tests |
| Vazamento de tokens | Token em payload/logs | Comprometimento | Allowlist + redaction + não ecoar | Auth e2e |
| Resultados de executores tratados como autoridade | Executor reporta "success" | Bypass de verification | Owner verification attestation + mission verifier | Verification tests |

**Invariantes de threat model (PROPOSTA):**

- Nenhum conteúdo de modelo ou ferramenta pode alterar a policy.
- Nenhum campo de payload pode conceder autoridade.
- Fail-closed em toda ausência de evidência.

---

## 11. Compatibilidade e migração

- Missions existentes permanecem válidas; `allowedCapabilityScope` persistido é tratado como cache legado.
- Grants são aditivos; sem migração destrutiva.
- `MISSION_CONTRACT_VERSION` permanece 1; grant contract tem versão própria (1).
- Se grant ledger não existir (dados antigos), escopo efetivo = valor persistido; novos grants adicionam.
- Projeções públicas (`projectMission`) não expõem scope nem grants (PROVADO NO CÓDIGO: `durable-projection.ts`).
- Contratos públicos existentes não são alterados (restrição da issue).

---

## 12. Matriz de testes projetados (futuros)

| Categoria | Testes |
|---|---|
| Authz 401/403 | Operação sem scope → 403; sem credencial → 401; scope `mission.create` não concede grant |
| Rollback SQLite real | Falha no meio da transação → rollback; nenhum grant parcial |
| Concorrência | Revoke vs dispatch; grants paralelos; idempotência concorrente |
| Idempotência/conflitos | Replay de grant; conflito de fingerprint |
| Restart | Recovery do escopo a partir do ledger; nenhum invocation duplicado |
| Expiração/revogação | Grant expirado não autoriza; revoke remove contribuição |
| Publisher/observer após commit | Mutation publicada só após commit; rollback não publica |
| Ausência de capabilities implícitas | Mission nova tem escopo vazio; nenhum grant implícito |
| Regressões de admissão | `mission.admit` continua criando EMPTY_SCOPE |
| Revalidação de policy | Dispatch revalida scope atual |
| Nenhuma Invocation após revogação | Dispatch rejeitado após revoke |
| Efeito submetido/incerto | Sem replay automático; reconciliação via authority |
| Daemon E2E real | Daemon real, SQLite temporário, credenciais provisionadas |
| Preservação de contratos públicos | Schemas/versões inalterados |

**Regra (CONTRATO EXISTENTE):** mock isolado não prova recovery nem integração. Testes devem usar daemon real + SQLite temporário onde aplicável.

---

## 13. Decomposição futura (slices independentes)

### Slice A — Persistência e policy de grants, sem superfície pública

- **Objetivo:** criar ledger + derivação de escopo efetivo + validação contra limites, sem RPC/CLI.
- **Dependências:** nenhuma (base atual).
- **Arquivos prováveis:** `cli/src/mission/sqlite-mission-store.ts`, novo `cli/src/mission/capability-grants.ts`, `cli/src/mission/contracts.ts`, `cli/src/mission/ports.ts`, testes.
- **Contratos:** `MISSION_CONTRACT_VERSION` inalterado; novo contrato de grant v1.
- **Limites de autoridade:** apenas store/policy; nenhuma superfície pública.
- **Invariantes:** ledger é autoridade; cache recomputável; fail-closed.
- **Testes:** unit + SQLite real (rollback, restart, idempotência).
- **Aceite:** store persiste/recomputa escopo; testes passam; `bun run check`.
- **Evidência necessária:** restart real, rollback real.
- **Riscos/stop conditions:** se ledger não puder ser transacional com Mission → parar.

### Slice B — Operação autenticada e auditável de concessão/revogação

- **Objetivo:** expor `mission.grant_capabilities` e revoke via RPC/CLI, com auth scope dedicado.
- **Dependências:** Slice A; decisão de scope (`mission.grant_capabilities`).
- **Arquivos prováveis:** `shared/local-control-*-contract.ts`, `cli/src/daemon/local-control-auth.ts`, `cli/src/daemon/server.ts`/rpc-gateway, `cli/src/commands/admin-cli.ts`, `cli/src/daemon/local-control-admission.ts` (padrão), testes e2e.
- **Contratos:** novo contrato versionado.
- **Limites de autoridade:** grantor validado contra fonte independente; `daemon.admin`/`mission.create` não concedem.
- **Invariantes:** identidade derivada do contexto; allowlist de campos; limites de tamanho.
- **Testes:** authz 401/403, e2e daemon real.
- **Aceite:** operação funcional com credencial adequada; negada sem scope.
- **Evidência necessária:** daemon E2E real.
- **Riscos/stop conditions:** se novo scope não aprovado → não implementar.

### Slice C — Planejamento consultivo e aceitação sob escopo autorizado

- **Objetivo:** garantir que `proposePlan`/`acceptPlan` usem scope atual e revalidem; possivelmente adicionar operação de "request plan" sob scope.
- **Dependências:** Slices A-B.
- **Arquivos prováveis:** `cli/src/mission/mission-engine.ts`, `policy.ts`.
- **Contratos:** inalterados.
- **Limites:** planner continua advisory.
- **Invariantes:** revalidação antes de aceitação.
- **Testes:** policy + engine.
- **Aceite:** planos com capabilities fora do scope rejeitados em todas as etapas.
- **Evidência:** testes de engine.
- **Riscos:** se scope mudar mid-plan → rejeitar aceitação.

### Slice D — Integração de execução

- **Objetivo:** dispatch e submissão de efeitos condicionados ao scope atual; reconciliação.
- **Dependências:** Slices A-C + aprovação específica.
- **Arquivos prováveis:** `mission-engine.ts`, dispatch seam, scheduler.
- **Contratos:** inalterados.
- **Limites:** sem replay automático; fail-closed.
- **Invariantes:** revalidação antes de cada efeito.
- **Testes:** e2e real, recovery, concorrência.
- **Aceite:** nenhuma invocation após revogação; evidência preservada.
- **Evidência:** daemon E2E real.
- **Riscos/stop conditions:** se reconciliação não puder ser provada → parar.

---

## 14. Decisões que exigem aprovação de Pedro (DECISÃO PENDENTE)

1. **Nome do scope de autenticação** para concessão (`mission.grant_capabilities` vs `capability.grant` vs outro).
2. **Fonte confiável de limites máximos do grantor** (arquivo de policy vs coluna na tabela de auth vs config de daemon).
3. **Composição:** union (recomendado) vs teto de Mission definido na admissão.
4. **Idempotência do grant:** `grantId` fornecido pelo cliente (recomendado) vs derivado pelo daemon.
5. **Exposição de `grantorClientId`** na projeção pública.
6. **Revogação de grantor:** desativar grants para novos efeitos (recomendado) vs revogar automaticamente.
7. **Leitura de grants:** scope `mission.read` vs novo scope.
8. **Expiração default:** permitir grants sem expiração (recomendado, mas revogáveis) vs exigir `expiresAt`.
9. **Compatibilidade legado:** tratar `allowedCapabilityScope` persistido como cache legado (recomendado) vs migrar para grants sintéticos.
10. **Nomes finais das operações RPC** e versionamento.

**Nenhuma dessas decisões é presumida.** Toda implementação futura depende de aprovação explícita.

---

## 15. Evidências e referências ao código

**PROVADO NO CÓDIGO:**

- `cli/src/daemon/local-control-admission.ts:25-35,153` — `EMPTY_SCOPE` e criação de Mission com escopo vazio.
- `cli/src/mission/contracts.ts:126-136` — `AllowedCapabilityScope`.
- `cli/src/mission/policy.ts:100-175` — `PlanPolicyValidator`, `CAPABILITY_NOT_AUTHORIZED`, `EFFECT_NOT_AUTHORIZED`.
- `cli/src/mission/mission-engine.ts:424-485` — `createMission`.
- `cli/src/mission/mission-engine.ts:489-550` — `proposePlan`.
- `cli/src/mission/mission-engine.ts:562-665` — `acceptPlan`.
- `cli/src/mission/mission-engine.ts:671-700` — `recordApproval`.
- `cli/src/mission/mission-engine.ts:726-900` — `dispatchStep`.
- `cli/src/daemon/local-control-auth.ts:338-365` — `requiredLocalControlScope`.
- `shared/local-control-auth-contract.ts:1-10` — scopes.
- `cli/src/mission/sqlite-mission-store.ts:1918-1945` — `withTransaction`.
- `cli/src/daemon/durable-projection.ts:40-55` — `projectMission`.

**CONTRATO EXISTENTE:**

- `docs/MISSION_CONTRACT.md` — Mission contract v1, approval authority.
- `docs/decisions/2026-10-08-local-control-authz.md` — decisão de authz local.
- `docs/ARCHITECTURE.md` — fluxo autoritativo, Current/Direction/Legacy.
- `AGENTS.md` — regras, baseline.

**PROPOSTA (este documento):** toda a §5-§9, §13-§14.

**HIPÓTESE:**

- Necessidade de autoridade externa (Alternativa C) para multi-host.
- Redução de CPU/RAM de revalidação (não medido).

**DECISÃO PENDENTE:** §14.

---

## Nota final

Este documento é **proposta normativa**. Não implementa código, não altera contratos, não concede autorizações. A implementação futura, se aprovada, deve seguir os slices da §13 com gates da §12 e aprovação explícita de Pedro para as decisões da §14.

**Tarefa termina em: NEEDS_APPROVAL — aguardando decisão normativa sobre o contrato de grants.**
```<|end|><|start|>translator<|channel|>analysis<|message|>Now write file. Then git diff --check, status. Then commit, push, PR. Need ensure only doc added. Let's write.<|end|><|start|>start<|channel|>write<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="path">
docs/analysis/operator-capability-grant-trust-contract-2026-10-29.md