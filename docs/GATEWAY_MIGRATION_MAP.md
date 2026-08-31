# GatewayOrchestrator Migration Map (Issue #63)

> **Status**: Direction — migration plan, not a removal PR.
> **Authority**: #60, #63, `docs/LEGACY_MATRIX.md` (#61), `docs/ORCHESTRATOR_MIGRATION_MAP.md` (#62).
> **Goal**: make explicit, reconciled with the current code, how the legacy
> `cli/src/orchestration/GatewayOrchestrator.ts` and its hardcoded bridges map
> to the new capability architecture (`cli/src/capabilities/`). No mass removal
> and no bridge rewiring happens in the #63 PR.

This map classifies each concept as:

- **Reutilizável** — semantics that survive, under the new contract;
- **Adaptável** — useful idea, must be reshaped;
- **Legado** — does not define direction; kept only for compatibility;
- **Issue posterior** — responsibility owned by a future issue.

---

## 1. The pattern being retired: hardcoded bridges

`GatewayOrchestrator` directly constructs and owns provider bridges
(`AntigravityBridge`, `GeminiCliBridge`, `JulesBridge`) and exposes them
through gateway-level methods (`getBridges()`, `setGeminiModel()`,
`isJulesConfigured()`). Per #60/#61 this is the anti-pattern: a specific
provider defines the core's surface, and there is no deterministic policy
gate between "the gateway knows the provider" and "the provider acts".

The replacement architecture (#63) is:

```
CapabilityDescriptor (v1, registered)
        │  discovery only — never authorization
        ▼
CapabilityRegistry ──satisfies──▶ #62 CapabilityResolver (PlanPolicyValidator)
        │                                 │ deterministic policy decision
        │                                 ▼
        │                          dispatch seam (Mission Engine)
        │                                 │ authorized invocation only
        ▼                                 ▼
CapabilityConnector (v1) ◀────  invoke/observeStatus/cancel/reconcile
```

Discovery (registry) and authorization (policy) remain separate: a
capability being registered never implies a Mission may invoke it. This
invariant is proven in `cli/src/capabilities/integration.test.ts`.

## 2. Bridge-by-bridge mapping

| Legacy construct (GatewayOrchestrator) | Classification | Destination |
|---|---|---|
| `AntigravityBridge` direct field + construction | **Adaptável** (#63 contract exists; rewiring later) | Versioned `CapabilityConnector` owned by an Antigravity capability module; descriptor registered in `CapabilityRegistry`; reachable only via the dispatch seam. Per LEGACY_MATRIX §10 |
| `GeminiCliBridge` direct field + `setGeminiModel()` | **Adaptável** | Planner provider behind the #62 planner contract — not a capability connector (model output is proposal/input, never authority). Per LEGACY_MATRIX §11 |
| `JulesBridge` optional field + `isJulesConfigured()` | **Adaptável** | Versioned connector for an external owner (Runstead/software work); Ouroboros formulates objective/acceptance and receives evidence. Per LEGACY_MATRIX §12 |
| `getBridges()` exposing bridge objects | **Legado** | Bridges are not a public gateway surface. Callers go through capability discovery + policy + dispatch |
| `initialize(apiKey)` top-level | **Adaptável** | Credentials live with the module owner / secret store; descriptors declare `credentialRequirement` by reference (`vault://…`), never raw secrets (#63 contract) |
| Constructor wiring of all subsystems | **Reutilizável** (idea) | Composition stays, but provider bindings move to registration-time `assertConnectorMatchesDescriptor` checks (version + describe match) instead of constructor hardwiring |

## 3. What `cli/src/capabilities/` provides today (the #63 deliverable)

| Piece | File | Notes |
|---|---|---|
| `CAPABILITY_REGISTRY_CONTRACT_VERSION = 1`, `CONNECTOR_CONTRACT_VERSION = 1` | `contracts.ts` | Versioned, provider-independent |
| `CapabilityDescriptor` (extends #62 `CapabilityContract`) | `contracts.ts` | Adds availability (8 states), idempotency, retry/backoff, cancellation, reconciliation, credential requirement, characteristics, degradation, typed input/result schema validators, expected owner-verification mode |
| `validateCapabilityDescriptor` | `contracts.ts` | Fail-closed; scans every declared string for raw secrets using the #62 detectors |
| `CapabilityRegistry` | `registry.ts` | register/replace/requireDescriptor/resolve/listRegistered/listDescriptors/setAvailability/describeForDiagnostics; duplicate registration rejected; availability never mutates authorization fields |
| `CapabilityResolver` compatibility | `registry.ts` | A `CapabilityRegistry` satisfies the #62 `CapabilityResolver` interface consumed by `PlanPolicyValidator` — no #62 change needed |
| `assertConnectorMatchesDescriptor` | `registry.ts` | Binding gate: connector contract version checked before `describe()`; deep match against the registered descriptor |
| `CapabilityConnector` (v1) | `connector.ts` | describe/invoke/observeStatus?/cancel?/reconcile?; typed `CapabilityResult` with `EvidenceReference` and `OwnerVerificationOutcome`; no raw provider text, no CoT channel |
| `defineCapabilityDescriptor` | `fixtures.ts` | Deterministic factory used by tests and future module owners; validates on construction |

## 4. Migration order (future issues, not this PR)

1. **Register** each surviving bridge as a capability: descriptor (v1)
   registered in a `CapabilityRegistry` instance; connector implements
   `CapabilityConnector` v1 backed by the existing bridge code.
2. **Gate**: route all invocations through the Mission dispatch seam;
   delete direct gateway→bridge call paths.
3. **Retire** `getBridges()`/`setGeminiModel()`/`isJulesConfigured()` from
   the gateway surface once no caller needs them.
4. **Credentials**: move API-key handling out of `initialize()` into the
   connector adapters, referencing the descriptor's `credentialRequirement`
   (by reference only).
5. **Issue posterior**: MCP/SkillLoader transport decision (#61-followup-10)
   is re-evaluated *after* this registry exists; MCP remains an optional
   transport behind `CapabilityConnector`, never the contract itself.
6. **Issue posterior**: durable scheduling of long-running capabilities
   (#50) and Context Compiler provenance (#64) are out of #63 scope.

## 5. Non-goals preserved by this map

- No bridge file is deleted or rewired in the #63 PR.
- No new dependency, transport, or network surface is introduced.
- The #62 Mission engine, policy, and stores are untouched
  (verified: `git diff origin/main...HEAD -- cli/src/mission/` is empty;
  mission suite green).
- Discovery/authorization separation is strengthened, not weakened: the
  registry-only path can resolve a capability that policy still rejects.
