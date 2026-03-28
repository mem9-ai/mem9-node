# mem9 / mem9-node Refactor Proposal (`codex/refactor-opt-20260328`)

## Background And Current State

- `mem9/dashboard/app` currently carries too much orchestration in [`space.tsx`](/Users/bosn/git/mem9/dashboard/app/src/pages/space.tsx). Route state, query wiring, local filtering, panel state, and layout rendering are tightly coupled, which is already surfacing as test brittleness and high regression cost.
- `mem9-node` has grown into a full `api + worker + shared` backend. The primary short-term risk is not missing features; it is service boundaries and runtime hardening. [`deep-analysis.service.ts`](/Users/bosn/git/mem9-node/apps/api/src/deep-analysis.service.ts) mixes policy, async source preparation, duplicate cleanup/export, and request orchestration. [`mem9-source.service.ts`](/Users/bosn/git/mem9-node/apps/api/src/mem9-source.service.ts) lacks request hardening. [`sqs-consumer.service.ts`](/Users/bosn/git/mem9-node/apps/worker/src/sqs-consumer.service.ts) duplicates message-loop logic and does not isolate malformed messages.
- This proposal stores the full roadmap in one place and defines the current implementation slice: only `P0/P1`.

## Full Roadmap (`P0-P5`)

### `P0`

- Restore reproducibility and quality baselines.
- Add lightweight `verify` scripts.
- Lock Node runtime for `mem9-node`.
- Fix known failing tests in `dashboard/app`.

### `P1`

- Refactor `dashboard/app` `space` into route shell, data model, selectors, and layout.
- Replace raw `setInterval` Memory Farm polling with React Query-driven state.
- Split `mem9-node` deep-analysis request orchestration from source preparation and duplicate operations.
- Harden `mem9-node` source fetch/delete logic with timeout, retry, and bounded concurrency.
- Reduce duplicated worker queue-loop logic and isolate malformed messages.

### `P2`

- Add summary endpoint support so dashboard no longer stitches stats with multiple requests.
- Replace dashboard full-cache rebuild flow with incremental sync.
- Defer heavy analysis startup until analysis UI is actually used.
- Reduce worker payload cloning and large dashboard chunk loading.

### `P3`

- Move deep-analysis source preparation out of API request-side process into a first-class background stage.
- Split `AnalysisRepository` by domain.
- Reduce “god service” ownership across deep-analysis execution.

### `P4`

- Rework worker consumption around bounded concurrency and better backoff.
- Batch or stage internal usage persistence to reduce write amplification.
- Continue shrinking heavy report and dashboard components.

### `P5`

- Add stronger CI budgets and cross-repo contract tests.
- Add integration smoke coverage across dashboard and mem9-node deep-analysis lifecycle.

## Current Execution Slice (`P0/P1`)

### `mem9-node`

- Add [`.nvmrc`](/Users/bosn/git/mem9-node/.nvmrc), README runtime guidance, and a root `verify` script.
- Extend typed config with:
  - `MEM9_SOURCE_REQUEST_TIMEOUT_MS`
  - `MEM9_SOURCE_FETCH_RETRIES`
  - `MEM9_SOURCE_FETCH_RETRY_BASE_MS`
  - `MEM9_SOURCE_DELETE_CONCURRENCY`
- Split deep-analysis API responsibilities into:
  - `deep-analysis.policy.ts`
  - `deep-analysis-source-preparation.service.ts`
  - `deep-analysis-duplicate-ops.service.ts`
  - a slimmer `deep-analysis.service.ts`
- Keep HTTP API, DB schema, and SQS message shapes unchanged.
- Harden source fetch/delete logic with timeout, bounded retry, and bounded delete concurrency.
- Refactor worker queue handling to share loop logic, read heartbeat interval from config, and keep malformed JSON from killing the loop.

### `mem9/dashboard/app`

- Split [`space.tsx`](/Users/bosn/git/mem9/dashboard/app/src/pages/space.tsx) into:
  - `use-space-route-state.ts`
  - `space-selectors.ts`
  - `use-space-data-model.ts`
  - `space-page-layout.tsx`
- Keep external route params and UI behavior unchanged.
- Replace raw Memory Farm polling with a React Query-driven local state hook.
- Add `verify` script.
- Fix current failing tests and add selector/state coverage.

## Acceptance Criteria

- Both repos build on branch `codex/refactor-opt-20260328`.
- `mem9-node` passes `pnpm verify` under Node 22 with dependencies installed.
- `dashboard/app` passes `pnpm verify`.
- `dashboard/app` known failures in `space.test.tsx` and `deep-analysis-tab.test.tsx` are resolved.
- `mem9-node` has tests for source timeout/retry/delete concurrency, deep-analysis delegation, and queue malformed-message handling.

## Risks And Explicit Non-Goals

- This round does not move source preparation to its own durable queue stage.
- This round does not redesign worker concurrency architecture.
- This round does not add Prisma migrations.
- This round does not change dashboard-to-Node HTTP contracts.
- This round does not add full CI workflows or hard bundle gates; only local `verify` guardrails are added.
