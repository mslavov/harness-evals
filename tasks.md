# Harness Evals Implementation Tasks

This task list turns the target architecture in `skills/harness-evals/docs/HDL.md` and `skills/harness-evals/docs/lld/*.md` into high-level implementation workstreams. It is based on the current `src/` implementation shape: single-prompt test cases, hardcoded built-in adapters, direct file artifact writes, ready-image Docker execution, and built-in assertions. Output providers, scoring, judging, cost accounting, managed images, MCP/CLI mocks, and result visualization are represented as task areas below.

## Dependency graph

```text
T1 Config/domain model alignment
  ├─> T2 Adapter registry and contract
  │     ├─> T5 Managed runtime images
  │     └─> T8 MCP and CLI mocking
  ├─> T3 Output records and providers
  │     ├─> T4 Test-case runner and step lifecycle
  │     ├─> T5 Managed runtime images
  │     ├─> T6 Validation, scoring, and judging
  │     ├─> T7 Cost accounting and summaries
  │     ├─> T8 MCP and CLI mocking
  │     └─> T9 Result visualization
  └─> T4 Test-case runner and step lifecycle
        ├─> T6 Validation, scoring, and judging
        ├─> T7 Cost accounting and summaries
        └─> T8 MCP and CLI mocking

T6 + T7 + T8 ──> T9 Result visualization
T1..T9 ───────> T10 Agent-first skill packaging and onboarding
```

## Tasks

| ID | Task | Depends on | Outcome |
| --- | --- | --- | --- |
| T1 | Align config and domain model with the HLD/LLDs | None | Test case files under `evals/tests/` support one-shot prompts or `steps`; `harness-evals.yaml` supports `tests` glob overrides plus `adapters`, `mocks`, `output`, `visualization`, `judge`, and `scoring`. |
| T2 | Implement adapter registry and expanded adapter contract | T1 | Built-ins and YAML-declared project adapters resolve through one registry; adapters expose `prepareStep`, `parseEvents`, optional `getInstallRecipe`, optional `applyMcpMocks`, continuation metadata, cleanup paths, and normalized cost reporting. |
| T3 | Add normalized output records, dispatcher, and file provider | T1 | The runner and subsystems emit ordered, redacted `OutputRecord`s; default file provider owns the documented artifact layout and `.harness-evals/output/latest/*`; custom providers can be loaded from config. |
| T4 | Replace one-shot test execution with test-case/step lifecycle | T1, T2, T3 | Each `(test case, agent)` run copies the workspace once, executes one or more steps, passes adapter continuation, gates later steps on required assertions, and emits step/run records. |
| T5 | Add managed runtime image resolver | T2, T3 | `docker.image` is treated as a ready-image bypass; otherwise the harness collects adapter install recipes/probes, builds or reuses deterministic local images, validates probes, and emits `image.resolution`. |
| T6 | Implement validation, LLM judging, and scoring | T1, T3, T4 | Assertions include `id`, `required`, and `llmJudge`; judge calls use top-level `judge` defaults; project `scoring` weights assertion pass rate, judge score, latency, cost, and token usage into step/test-case/run summaries. |
| T7 | Implement cost accounting and rollups | T2, T3, T4, T6 | Adapter and judge usage/cost reports are normalized into `step.cost`, `scenario.costSummary`, and run summaries with provider/model/step/test-case/agent rollups. |
| T8 | Implement deterministic MCP and CLI mocking | T1, T2, T3, T4 | Test cases can declare `mocks.cli` and `mocks.mcp`; wrappers stage deterministic responses, record `mock.config`/`mock.call`, and support assertions over external tool behavior without live services. |
| T9 | Implement result visualization | T3, T4, T6, T7, T8 | The file output path includes promptfoo-style `results.html`, `results.json`, and `results.csv`; `harness-evals view` opens or serves latest/historical reports. |
| T10 | Package the agent-first `harness-evals` skill and onboarding flow | T1, T2, T3, T4, T5, T6, T7, T8, T9 | Distributable skill includes `SKILL.md` plus source docs and guides agents through install, config, test-case creation, mocks, selected agents, outputs, visualization, judge/scoring defaults, and first-run validation. |

## Task detail

### T1 — Align config and domain model with the HLD/LLDs

**Scope**
- Update config schema/types so individual test case files with one-shot prompts or `steps` are first-class.
- Use `evals/tests/**/*.yaml` as the default test discovery path.
- Keep `harness-evals.yaml.tests` as a simple list of project-relative glob patterns that override the default.
- Add top-level `adapters`, `mocks`, `output.providers`, `visualization`, `judge`, and `scoring` config shapes.
- Make `docker.image` optional in the model, where absence means managed-image mode.
- Validate unknown assertion/scoring/provider/adapter/visualization keys early enough to fail before Docker execution.

**Implementation anchors**
- `src/config/schema.ts`
- `src/config/load.ts`
- `src/config/merge.ts`
- `src/runner/matrix.ts`
- `tests/core.test.ts`

**Acceptance checks**
- Config loading accepts the documented YAML shapes from the LLDs.
- Test case files under `evals/tests/**/*.yaml` can define one-shot prompts or many steps.
- Agent include/exclude/override behavior still works against test cases.
- Existing path traversal protections still apply to workspaces, fixtures, test files, and mock files.

### T2 — Implement adapter registry and expanded adapter contract

**Scope**
- Create an adapter registry that registers built-ins first, then project-defined adapters from `harness-evals.yaml.adapters`.
- Support project-relative modules and package specifiers with `default`/named export resolution.
- Validate adapter contract before matrix execution.
- Rename the runtime contract from `prepareRun` to `prepareStep` and pass test case, step, step index, step directory, continuation, and mock runtime plan.
- Extend event summaries to include optional cost reports.
- Add `getInstallRecipe` and probe support for managed images.
- Add optional `applyMcpMocks` for adapters that can rewrite MCP server config.

**Implementation anchors**
- `src/adapters/types.ts`
- `src/adapters/*.ts`
- `src/runner/evaluate.ts`
- new `src/adapters/registry.ts`

**Acceptance checks**
- Built-in adapters are listed with metadata.
- A project adapter can override a built-in by name.
- Unknown or invalid adapter names fail during config/registry resolution.
- Built-in adapters compile against the new step contract.
- MCP mock declarations fail actionably for adapters without MCP mock support.

### T3 — Add normalized output records, dispatcher, and file provider

**Scope**
- Define `OutputRecord`, `OutputProvider`, provider config, blob refs, and finalize contracts.
- Add an output dispatcher that assigns sequence numbers, redacts records, and fans out to providers.
- Move artifact writes behind the default file provider.
- Add record types for image resolution, mock config/calls, step details, assertions, score, cost, run results, and visualization reports.
- Load custom output providers from config.
- Preserve local inspectability through the documented file layout.

**Implementation anchors**
- `src/runner/artifacts.ts`
- `src/runner/evaluate.ts`
- `src/redaction.ts`
- new `src/output/*`

**Acceptance checks**
- Omitting `output.providers` enables the file provider.
- Each run emits `run.started`, mock records when applicable, step records, workspace diff, result, and summary records.
- File artifacts are written under `.harness-evals/runs/<test-case>-<agent>-<timestamp>/steps/<step-id>/`.
- Provider failures follow the documented default-file-provider and secondary-provider behavior.

### T4 — Replace one-shot test execution with test-case/step lifecycle

**Scope**
- Introduce test-case run contexts and step result types.
- Copy the workspace once per `(test case, agent)` run and keep it across steps.
- Execute steps linearly, passing adapter continuation between steps.
- Evaluate required assertions after each step and skip later steps when a required assertion fails.
- Emit per-step stdout/stderr, command metadata, event summary, assertions, completion status, and final test-case result records.

**Implementation anchors**
- `src/runner/evaluate.ts`
- `src/runner/result.ts`
- `src/docker/runner.ts`
- `src/workspace/*`

**Acceptance checks**
- A one-step test case behaves like the current one-shot flow.
- A multi-step test case shares workspace changes across steps.
- Required assertion failure stops later steps and marks them skipped.
- Timeout/error states are represented at step and test-case levels.

### T5 — Add managed runtime image resolver

**Scope**
- Implement ready-image mode when `docker.image` is supplied.
- Implement managed-image mode when `docker.image` is absent.
- Collect selected adapters' install recipes and probes, including mock-wrapper runtime requirements when needed.
- Normalize install manifests and compute deterministic cache keys.
- Build/reuse local Docker images and run probes before test-case execution.
- Emit image metadata through the output dispatcher.

**Implementation anchors**
- `src/docker/*`
- `src/adapters/types.ts`
- `src/runner/evaluate.ts`
- `src/cli.ts`
- new `src/docker/image-resolver.ts`

**Acceptance checks**
- Ready image mode never builds images and fails actionably on probe failure.
- Managed mode builds once per manifest key and reuses passing cached images.
- Probe failure after a cache hit triggers one rebuild for the same key.
- CLI behavior matches the documented managed-image and ready-image flows.

### T6 — Implement validation, LLM judging, and scoring

**Scope**
- Extend assertion config/result types with `id`, `required`, `score`, `threshold`, reason, and metadata.
- Fail config loading for unknown assertion types and invalid `llmJudge` definitions.
- Implement `llmJudge` assertions through `@mariozechner/pi-ai` with redacted inputs and top-level judge defaults.
- Add score bucket aggregation for assertion pass rate, judge score, latency, cost, and token usage.
- Make tool calls and mock calls available to assertions and judge inputs.
- Emit `step.judge`, `step.assertions`, `step.score`, and `scenario.scoreSummary` records.

**Implementation anchors**
- `src/assertions/*`
- `src/events/types.ts`
- `src/runner/evaluate.ts`
- new `src/scoring/*`
- new `src/judge/*`

**Acceptance checks**
- Missing assertion `required` defaults to `true`.
- `llmJudge` requires a normalized threshold and fails on invalid judge output.
- Score weights affect score summaries but not pass/fail gates.
- Final summaries include both pass/fail and normalized scores.

### T7 — Implement cost accounting and rollups

**Scope**
- Add `UsageReport`, `CostReport`, `CostRollup`, and `CostSummary` types.
- Preserve adapter-reported costs as authoritative; do not compute prices from tokens.
- Roll up costs by step, test case, agent, provider, model, and run where dimensions are available.
- Include judge usage/cost metadata in the same rollup model.
- Emit `step.cost` and `scenario.costSummary` records.

**Implementation anchors**
- `src/events/types.ts`
- `src/adapters/*.ts`
- `src/runner/evaluate.ts`
- new `src/cost/*`

**Acceptance checks**
- Missing cost data is explicit and does not fail otherwise valid steps.
- Cumulative agent totals are represented according to adapter metadata.
- Mixed currencies are not summed into a misleading single total.
- Cost fields appear in step, test-case, and run summaries when reported.

### T8 — Implement deterministic MCP and CLI mocking

**Scope**
- Add mock config and test-case/step `mocks` declarations.
- Resolve mock fixture files under `evals/mocks/cli` and `evals/mocks/mcp`.
- Stage CLI wrapper scripts ahead of real commands on `PATH`.
- Stage MCP stdio wrapper plans and call logs under the run config directory.
- Let adapters apply MCP wrapper plans to agent-specific MCP config.
- Implement first-match response rules, simple glob matching, strict mode, and call recording.
- Emit `mock.config` and `mock.call` records and expose mock calls to assertions, scoring, judging, and visualization.

**Implementation anchors**
- new `src/mocks/*`
- `src/adapters/types.ts`
- `src/adapters/*.ts`
- `src/runner/evaluate.ts`
- `src/docker/runner.ts`
- `tests/core.test.ts`

**Acceptance checks**
- A CLI mock can shadow a command and return configured JSON/stdout/exit code.
- An MCP mock can intercept `tools/call` and record matched/unmatched calls.
- Strict mode fails unmatched mocked external calls.
- Step-level mocks override test-case mocks for that step only.
- Mock calls can be asserted and appear in reports.

### T9 — Implement result visualization

**Scope**
- Build a report view model from output records and file-provider artifacts.
- Render static `results.html`, `results.json`, and `results.csv` under `.harness-evals/output/latest/`.
- Write per-run `index.html` under run artifact directories.
- Add `harness-evals view` for latest/historical reports and `harness-evals export` for explicit formats.
- Include pass/fail, score, assertions, duration, cost, token usage, tool calls, mock calls, judge results, logs, and workspace diffs.

**Implementation anchors**
- new `src/visualization/*`
- `src/output/*`
- `src/cli.ts`
- `src/runner/result.ts`

**Acceptance checks**
- Latest runs produce HTML, JSON, and CSV reports by default when file output is enabled.
- Reports compare agents/models side-by-side by test case.
- Failed assertions, mock calls, tool calls, cost, score, and diffs are visible or linked.
- Reports are generated from redacted records/artifacts only.

### T10 — Package the agent-first `harness-evals` skill and onboarding flow

**Scope**
- Add `skills/harness-evals/SKILL.md` with the docs index described in the LLD.
- Keep `skills/harness-evals/docs/HDL.md` and `skills/harness-evals/docs/lld/*.md` as the skill-owned source docs.
- Update package distribution so the Skills CLI can install the skill.
- Align `harness-evals init` output with the final test-case/config schema.
- Add starter test case, optional mock fixture, visualization defaults, and validation flow that produces a working first eval.

**Implementation anchors**
- `skills/harness-evals/docs/*`
- `package.json`
- `src/config/load.ts`
- `src/cli.ts`
- new `skills/harness-evals/*`

**Acceptance checks**
- Installed skill exposes `/harness-evals` guidance and references bundled docs.
- Skill instructions ask for missing inputs one at a time and never write secrets.
- Generated starter config uses `tests` discovery, selected agents, optional outputs, visualization defaults, judge/scoring defaults, and a runnable first test case.
- README and package metadata point users to the agent-first setup path.

## Suggested implementation sequence

1. Land T1 and update tests around schema loading and matrix construction.
2. Land T2 so all runtime execution uses the final adapter boundary.
3. Land T3 so subsequent work emits records instead of writing artifacts directly.
4. Land T4 to make test-case/step execution the core runner path.
5. Land T5 to resolve runtime images before the test-case matrix executes.
6. Land T6 and T7 to complete scoring, judging, and cost records.
7. Land T8 so integration-heavy test cases can run deterministically.
8. Land T9 so run results are easy to compare and triage.
9. Land T10 once the public config and CLI behavior are stable.

## Cross-cutting verification

For each task, update or add tests close to the changed subsystem and run:

```bash
bun run check
bun test
bun run build
```
