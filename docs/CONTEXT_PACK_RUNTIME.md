# Progressive Context Packs (#78)

`ProgressiveContextPackRuntime` composes a Mission working set over the #64
`ContextCompiler` and #63 `SeamBoundContextReader`. It does not replace those
contracts or own external module data.

## Initial pack and expansion

`compileInitial(missionId, request)` loads the durable Mission and compiles a
mission-only `BoundedContextPackage`. It does not consult an external owner.
The pack also contains a sanitized projection of the Mission's intent,
objective, constraints, acceptance criteria, and evidence references. This
mandatory projection is reserved before optional context is compiled. If it
cannot fit, compilation fails explicitly; mandatory fields are never silently
truncated.

`expand(pack, { correlationId, requesterInvocationId?, request })` is the only
progressive read path. It requires a mission-bound request with an owner hint
and accepted READ step. The reader rechecks the current Mission scope, accepted
step, capability registry and ref prefix before dispatch. A planner suggestion
or owner hint does not grant permission. The requested budget, epistemic
classes and freshness requirement can only stay within or tighten the initial
pack. Each returned pack is a new cumulative #64 package; stale source items
are removed when their expiry or a re-acquisition's version/freshness anchor
changes.

The expansion identity is a deterministic hash of Mission, requesting
Invocation (if present), step, correlation id, request and source contract
version. The request id stored in Mission telemetry is hashed, not the
free-form selector. The existing Mission invocation replay barrier enforces one
submission per accepted Mission step. Completed reads are reused only through
the seam's owner reconciliation path; a repeated request never trusts a
previous package as authorization. Connectors without safe reconciliation
return an honest unresolved state.

A pack is serializable inert data. Its runtime expansion handle is tied to the
current runtime instance; after restart, callers compile a new initial pack
from durable Mission state and references. The previous pack is not restored
as a source of truth and no model/tool transcript is replayed.

## ResultArtifact

`createResultArtifact()` produces a provider-neutral, module-neutral,
versioned handoff with status, outcome, evidence/artifact refs, concise facts
and decisions, blockers, unresolved items, follow-up refs and sanitized
diagnostics. It has strict item/character limits, rejects unknown fields (such
as `transcript`) and fails closed on secret-bearing identities. It is data,
not an instruction or verification authority. Consumers must place only the
small information needed by the next stage in these fields.

This issue defines the generic artifact contract; no Runstead, Katherine or
Cadinho integration is included. The provider-side Runstead contract remains
with #66/#82.

## Mission accounting

The latest content-free scalar snapshot is stored in `Mission.contextAccounting`
using the existing Mission SQLite store:

- bytes are UTF-8 bytes of the serialized mandatory Mission projection plus
  context item content;
- chars are UTF-16 code units for the same payload;
- items count the mandatory Mission projection as one item plus compiled
  context items;
- token usage is `estimated` with the local `chars_div_4` heuristic. No exact
  or provider-reported count is inferred when none is available;
- requests, expansions, omissions, unresolved sources, durable Invocation ids,
  calls and attempts are recorded without copying context contents;
- request/expansion/call/attempt counters survive runtime recompilation from
  the stored Mission snapshot; initial/aggregate sizes describe the latest
  recomposed working set;
- Mission completion updates the same snapshot with the Mission verification
  outcome. A negative owner verification still blocks completion.

The package's `maxTotalChars` and item/token limits include the mandatory
projection through the progressive wrapper. The #64 package retains its own
budget report for compiled context items. Optional context that does not fit
remains excluded with explicit budget metadata.

## Current limits

No provider token report, latency-to-first-action, context-quality score or
baseline-versus-compiled comparison is available through the current runtime
contracts, so this implementation does not claim those measurements. It adds
no vector database, semantic retrieval, hidden cache, model call, or network
path. Existing planner/provider consumers have not yet been wired to request
these packs; this module establishes the operational API and deterministic
proof path for that integration work.
