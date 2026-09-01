# 🗺️ Context Compiler Migration Map (#64)

How to migrate the legacy ad-hoc memory/context path onto the #64 Context
Compiler boundary, **without rewriting** `MissionEngine` or the
`CapabilityRegistry`. Statuses: **Now** = this PR, **Next** = follow-up
issues, **Later** = after #50 (durable runtime primitives).

## From → To

| Legacy module | What it does today | #64 boundary contract | Status |
|---|---|---|---|
| `cli/src/orchestration/MemoryRetriever.ts` | Indexes past logs (fs reads, chunking, hybrid vector+keyword search, recency weighting) and returns top-k text chunks | A declarative `ContextRequest` (subject = opaque ref, budgets, `maxAgeMs`) compiled into a `BoundedContextPackage` with provenance; content reaches the planner ONLY as budgeted, classified, provenance-carrying DATA | Next (needs #50 storage seam) |
| `cli/src/orchestration/MemoryManager.ts` | Writes daily logs + `MEMORY.md`, extracts memories | Mission-owned context refs (`ContextReference`) + owner-side adapter serving rows through the `RegistryBoundContextReader`; ownership stays with the module, Ouroboros only carries references | Later |
| `cli/src/orchestration/memory-config.ts` | Tunables for chunk size/overlap/top-k, hybrid weights, recency half-life | Replaced by explicit `ContextBudget` (maxItems/maxTotalChars/maxEstimatedTokens) per request; no hidden defaults win over declared budgets | Next (trivial) |
| `cli/src/adapters/gemini-embedding.ts` (`GeminiEmbeddingClient`) | Google embeddings for hybrid search | Not needed by the boundary: the local `estimateTokens` heuristic (4 chars ≈ 1 estimated token) covers budgeting; semantic similarity is a module-owner concern, not a boundary concern | Not required; retire with #50 follow-ups |
| `cli/src/inference/EmbeddingEngine.ts` | Vector engine over embeddings | Same as above — the compiler is provider-independent by contract | Not required |
| `Orchestrator`/`GatewayOrchestrator` context assembly | Ad-hoc string assembly of memory text into prompts | Ask the compiler for a package; render items as references, not as policy/instructions | Next |

## Non-negotiables preserved during migration

1. **External content is DATA.** A rendered context item can never set
   intent, constraints, acceptance criteria, approvals or capability
   authorization — the package is deeply frozen and holds no functions.
2. **Authorization is structural.** Reads only happen through the
   `RegistryBoundContextReader`: #62 policy scope (capability allowlist,
   effect classes, ref prefixes) + #63 descriptor contract
   (ownsStorage=false, READ, input ref prefixes) BEFORE any adapter call.
   Discovery/availability is reported honestly (BUSY/DEGRADED → UNAVAILABLE,
   NEEDS_USER_ACTION → CONFIGURATION_ERROR), never promoted to fake success.
3. **Provenance is compiler-computed.** Adapters return opaque rows; owner
   identity, authorization, mission, purpose, sensitivity and freshness are
   computed by the compiler from the authorized descriptor.
4. **Secrets fail closed.** Unredactable secret-like content is excluded
   with an honest `secret_refused` record; RESTRICTED rows stay
   reference-only. No secrets, no chain-of-thought in durable context.
5. **Restart = recomposition.** `recompileAfterRestart(mission, request,
   reads, { clock })` rebuilds the same package deterministically — no
   prompt/output cache, no replay of model output, no network.
6. **Declared ≠ implemented ≠ verified.** Capabilities stay in the #63
   registry; `Closes #64` criteria are proven by the 27 offline tests in
   `cli/src/context/context-compiler.test.ts` + full `bun run check`.

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
