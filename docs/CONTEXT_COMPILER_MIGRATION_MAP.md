# 🗺️ Context Compiler Migration Map (#64)

How to migrate the legacy ad-hoc memory/context path onto the #64 Context
Compiler boundary, **without rewriting** `MissionEngine` or the
`CapabilityRegistry`. Statuses: **Now** = this PR, **Next** = follow-up
issues, **Later** = after #50 (durable runtime primitives).

## Real architecture (as implemented)

```
MissionEngine (#62 plan) ──accepted READ step──▶ SeamBoundContextReader
        │                                              │
        │                                    dispatchThroughSeam (#63
        │                                    ConnectorDispatchSeam: identity,
        │                                    split-brain, schemas, honest status)
        │                                              │
        ▼                                              ▼
ContextCompiler ◀──SeamAuthorizedRead[] (sealed, non-forgeable)── packageOutcome
     │
     ▼
BoundedContextPackage (deep-frozen inert DATA)
```

- **`SeamBoundContextReader`** (`cli/src/context/sources.ts`): the ONLY
  production path to external content. It validates the accepted plan,
  dispatches through the #63 seam, packages the outcome, and — after all
  gates — seals it via `getSeamSeal()`. There is **no caller-provided
  `SeamDispatchOutcome` path and no `alreadyAuthorized` path**: the engine
  exposes no API that proves invocation/result identity for outcomes
  dispatched elsewhere (that proof needs #50-grade reconciliation records,
  explicitly deferred).
- **`SeamAuthorizedRead`** (`cli/src/context/compiler.ts`): a nominal class
  whose construction requires a module-private token. Even `as any`
  construction throws at runtime; a shallow structural copy loses the brand
  and is refused by `compile()`'s `instanceof` gate. Raw
  `{descriptor, rows}` objects are refused with the same fail-closed error.
- **`ContextCompiler`**: mission-owned refs (durable `ContextReference`s)
  compile as FACT with mission authorization; sealed reads compile with
  provenance computed from the **authorized descriptor** (never from the
  connector); additions (`addInference`, `deriveSummary`) re-run the
  class/dedup/budget/sanitization pipeline.

## From → To

| Legacy module | What it does today | #64 boundary contract | Status |
|---|---|---|---|
| `cli/src/orchestration/MemoryRetriever.ts` | Indexes past logs (fs reads, chunking, hybrid vector+keyword search, recency weighting) and returns top-k text chunks | A declarative `ContextRequest` (subject = opaque ref, budgets, `maxAgeMs`) compiled into a `BoundedContextPackage` with provenance; content reaches the planner ONLY as budgeted, classified, provenance-carrying DATA | Next (needs #50 storage seam) |
| `cli/src/orchestration/MemoryManager.ts` | Writes daily logs + `MEMORY.md`, extracts memories | Mission-owned context refs (`ContextReference`); if served as external rows, the module owner registers a `context:*` capability and rows flow through the #63 seam as sealed reads. Ownership stays with the module; Ouroboros only carries references | Later |
| `cli/src/orchestration/memory-config.ts` | Tunables for chunk size/overlap/top-k, hybrid weights, recency half-life | Replaced by explicit `ContextBudget` (maxItems/maxTotalChars/maxEstimatedTokens) per request; no hidden defaults win over declared budgets | Next (trivial) |
| `cli/src/adapters/gemini-embedding.ts` (`GeminiEmbeddingClient`) | Google embeddings for hybrid search | Not needed by the boundary: the local `estimateTokens` heuristic (4 chars ≈ 1 estimated token) covers budgeting; semantic similarity is a module-owner concern, not a boundary concern | Not required; retire with #50 follow-ups |
| `cli/src/inference/EmbeddingEngine.ts` | Vector engine over embeddings | Same as above — the compiler is provider-independent by contract | Not required |
| `Orchestrator`/`GatewayOrchestrator` context assembly | Ad-hoc string assembly of memory text into prompts | Ask the compiler for a package; render items as references, not as policy/instructions | Next |

## Non-negotiables preserved during migration

1. **External content is DATA.** A rendered context item can never set
   intent, constraints, acceptance criteria, approvals or capability
   authorization — the package is deeply frozen and holds no functions.
2. **Authorization is structural and single-path.** External reads happen
   ONLY through `SeamBoundContextReader` over the #63 `ConnectorDispatchSeam`
   (#62 policy scope: capability allowlist, effect classes READ, ref
   prefixes — checked BEFORE dispatch), sealed into `SeamAuthorizedRead`s
   that are the only input the compiler accepts. Discovery/availability is
   reported honestly (non-completed invocations, connector errors →
   UNAVAILABLE; out-of-prefix rows → UNSUPPORTED; out-of-scope → REVOKED),
   never promoted to fake success.
3. **`ownsStorage: true` is legitimate and stays.** A module owner reading
   its OWN storage through its OWN capability (e.g. LifeOS reading its
   journal) is the pattern the seam encodes. The boundary guarantee is that
   no storage paths, DB URLs, network calls or vector-DB handles cross into
   the package — only budgeted, classified, provenance-carrying rows.
4. **Provenance is compiler-computed.** Connectors return opaque rows;
   owner identity, authorization, mission, purpose, sensitivity and
   freshness are computed by the compiler from the authorized descriptor.
5. **Sensitivity accompanies redaction (one rule).** Any content that was
   sanitized by the compiler OR arrived already redacted (`[REDACTED]`
   markers) is marked `REDACTED` — never `NORMAL` next to redaction
   markers — across mission contextRefs, external rows, `addInference` and
   `deriveSummary`. Unredactable raw secrets are still refused outright
   (`secret_refused`); owner-declared `RESTRICTED` stays reference-only and
   is never loosened.
6. **Budgets are monotonically non-expanding.** The requester's budget is
   clamped by the runtime ceiling policy (`DEFAULT_REQUEST_BUDGET_POLICY`
   via `clampBudget`); every package records its EFFECTIVE limits, and any
   later mutation takes `min(own policy, recorded limits)` — a looser
   compiler can tighten but never widen. A package that already exceeds its
   recorded limits refuses to grow (no laundering of hand-built state);
   `observed ≤ limits` holds on every produced package.
7. **Freshness anchors to the source.** Expiry is `fetchedAt + maxAgeMs`
   from the SOURCE's own timestamp; recompiling later never renews validity
   — stale rows need re-acquisition through the seam.
8. **Restart = recomposition, honestly.** `recompileAfterRestart(mission,
   request, { clock })` recovers MISSION-OWNED context from durable state
   alone; external content is NOT authority across restarts and must be
   re-acquired through the seam (the engine's one-shot dispatch invariant
   refuses blind replay; reconciliation of already-dispatched invocations
   is #50 territory, explicitly deferred).
9. **Secrets fail closed.** No secrets, no chain-of-thought in durable
   context.
10. **Declared ≠ implemented ≠ verified.** Capabilities stay in the #63
    registry; `Closes #64` criteria are proven by the **50 offline tests**
    in `cli/src/context/context-compiler.test.ts` (217 including mission +
    capabilities regression suites) + full `bun run check`.

## Suggested follow-up slicing

- **#65 (Next):** wire the compiler into the planner context assembly:
  orchestrator renders `BoundedContextPackage.items` as reference-only DATA
  (smallest change, biggest authority win). `memory-config` budgets map to
  `ContextBudget` in the same slice.
- **#66 (Next):** memory as a context capability (`context:ouroboros-memory`
  descriptor + owner-side adapter), replacing direct fs reads; needs the #50
  durable storage seam for owner-owned rows.
- **#67 (Later):** retire `GeminiEmbeddingClient`/`EmbeddingEngine` from the
  context path once MemoryRetriever consumers compile through the boundary;
  keep them only where a module owner still wants semantic search internally.
- **#50 (Later):** durable invocation/reconciliation records would allow
  proving cross-restart result identity; until then the reader refuses any
  caller-provided outcome path (fail-closed by design).
