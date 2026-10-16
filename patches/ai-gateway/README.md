# Gateway fixes for CCR issues #1801, #1806 and #1808

The runtime dependency needs source changes as well as the CCR changes in this branch.

- Base: `@the-next-ai/ai-gateway` source commit `f061ad4` (the `feat/v1.0.22` branch, package version still 1.0.21).
- Fix: `c6cba47` on local gateway branch `codex/ccr-recent-issues`.
- Reviewable patch: `0001-fix-tool-ids-and-fusion-traces.patch`, including regression tests.
- Follow-up after reproducing the original issues: `0002-complete-native-replay-and-response-status.patch`. This repairs old invalid tool IDs on the native Anthropic passthrough path and retains the final upstream HTTP status/headers for ordinary converted responses, including transparent tool turns and parse retries.
- The patch sanitizes Anthropic tool IDs consistently in JSON, SSE and replayed call/result pairs, captures completed optimistic Fusion streams with billing enabled or disabled, and retains real upstream status/headers for buffered Fusion responses.
- Follow-up (2026-10-16): `0003-virtual-model-raw-trace-status.patch`. The virtual-model buffered response path (`sendVirtualModelResponse`, used by Helix recall / Fusion tool loops) built its raw-trace capture without an upstream response status, so `request_logs.status_code` stayed `0` for those turns even though the client got HTTP 200 — the request log rendered successful recall turns as unknown/failed. The patch threads the last upstream status into `sendVirtualModelResponse` and attaches it to both the non-streaming and streaming captures.
- Follow-up (2026-10-16): `0004-report-internal-tool-injection.patch`. The virtual-model tool loop injects original text back into the prompt when the model calls an internal recall tool (`hc_recall` / `history_recall`); that injected text is the cost of recalling compressed history but was never reported, so `request_logs.compression_recall_tokens` stayed `0` and the UI had nothing to show. The patch accumulates injected content length (chars) per internal call name and publishes a new `internal_tool_stats` raw-trace part; CCR tokenizes it and writes the recall token column.

## Build from source

In a gateway source checkout at the base commit, apply both patches in order, install its dependencies, and build:

```sh
git am /absolute/path/to/0001-fix-tool-ids-and-fusion-traces.patch
git apply /absolute/path/to/0002-complete-native-replay-and-response-status.patch
git apply /absolute/path/to/0003-virtual-model-raw-trace-status.patch
git apply /absolute/path/to/0004-report-internal-tool-injection.patch
npm run typecheck
npm run build
```

Then build CCR:

```sh
CCR_GATEWAY_SOURCE_DIR=/absolute/path/to/patched/gateway npm run build:assets
```

The second audit used `/tmp/ccr-audit-gateway` as an isolated source snapshot. Temporary directories are not deliverables; the two patches and the committed regression suites are the reproducible artifacts.

Do not assume a normal dependency install contains these fixes yet. The main dependency constraint remains `^1.0.21`. The desktop and Docker release workflows build the pinned source with both patches and verify its gateway regression tests. Desktop builds install that package on every platform; Docker builds consume it through `docker/local-ai-gateway`. Local CLI publishing must likewise build with an explicit patched `CCR_GATEWAY_SOURCE_DIR` until the gateway changes are released in the registry dependency.

## Verification

- Gateway TypeScript check and build passed.
- Gateway routes and tool ID suites: 158 tests passed.
- CCR's `packages/core/test/integration/gateway/recent-issues-wire.test.mjs` exercises the built gateway via real loopback HTTP and consumes its spool with `RawTraceSynchronizer` and the real SQLite writer. It covers direct/Fusion × JSON/SSE × billing on/off, usage after `finish_reason`, provider-filtered costs, native tool replay, fallback wire destinations, the original encoded Fusion verification ID, and live OAuth rotation/probes. Set `CCR_TEST_GATEWAY_ENTRY` to the absolute built `dist/index.js` (or CCR's bundled `packages/core/dist/main/next-ai-gateway.js`) when running it.
- No model credentials or real upstream calls were needed.
