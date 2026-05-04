# LLD — Test Case Runner and Step Lifecycle

> **HLD:** `../HDL.md`
> **Companion LLDs:** `agent-first-install-and-config.md`, `adapter-registry-and-contract.md`, `managed-images.md`, `validation-scoring-and-judging.md`, `cost-and-artifacts.md`, `output-providers.md`, `mock-mcps-and-clis.md`, `result-visualization.md`
> **Status:** Draft

## How this fits

This LLD defines how the harness executes one-shot and multi-step test cases while preserving the HLD invariants for workspace isolation, explicit scenario lifecycle, adapter-owned continuation behavior, and deterministic measurement.

## 1. Domain Overview

A test case is the authored evaluation unit. By default, test cases live as individual YAML files under `evals/tests/`; when `harness-evals.yaml` omits `tests`, the loader reads `evals/tests/**/*.yaml`. Projects can override that default by setting `tests` to a list of project-relative glob patterns.

The runner owns orchestration for a single `(test case, agent)` matrix entry. It creates the isolated workspace, executes steps in order, applies required assertions between steps, passes previous-step continuation metadata back to the adapter, and emits step-level and run-level output records. The runtime scenario id is the test case id.

The runner does not know agent-specific continuation flags, transcript formats, config files, or cost accounting details. Those remain adapter responsibilities. The runner only coordinates the generic lifecycle and sends normalized output records to the output dispatcher.

## 2. Data Model / Contracts

### Test selection shape

`harness-evals.yaml` selects which test case files participate in the run. Omitting `tests` means the default below.

```yaml
tests:
  - evals/tests/**/*.yaml
```

Projects can override the default discovery path:

```yaml
tests:
  - evals/critical/**/*.yaml
  - packages/*/evals/tests/**/*.yaml
```

Test selection rules:

1. `tests` is a list of project-relative glob patterns.
2. Glob patterns may not escape the project root.
3. An explicit `tests` list replaces the default `evals/tests/**/*.yaml` discovery.

### Test case shape

Each discovered YAML file defines one test case. A test case can be one-shot or multi-step.

```yaml
# evals/tests/checkout-refactor.yaml
id: checkout-refactor
description: Refactor checkout flow across multiple prompts
workspace:
  fixture: evals/fixtures/checkout
agents:
  include: [pi-gemini, claude-sonnet]
mocks:
  cli:
    jira-cli: jira-cloud-success
steps:
  - id: plan
    prompt: Review the checkout module and propose a minimal refactor plan.
    assert:
      - type: contains
        value: refactor
  - id: implement
    prompt: Implement the approved minimal refactor.
    assert:
      - type: exitCode
        equals: 0
      - type: workspaceDiff
        minChanged: 1
  - id: polish
    prompt: Run checks and fix any issues.
    assert:
      - type: noToolErrors
```

One-shot test cases can use the shorthand form. The loader normalizes this to one step.

```yaml
# evals/tests/quick-smoke.yaml
id: quick-smoke
prompt: Say OK and do not edit files.
assert:
  - type: contains
    value: OK
  - type: workspaceDiff
    changedFiles: []
```

### Normalized test case entities

```ts
type ScenarioStepStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'timeout'
  | 'error';

interface HarnessConfig {
  tests: string[];
}

interface TestCaseDefinition {
  id: string;
  description?: string;
  suite?: string;
  workspace?: WorkspaceOverride;
  agents?: AgentsSelection;
  mocks?: TestCaseMockConfig;
  steps: TestCaseStepDefinition[];
  timeoutMs?: number;
  sourcePath?: string;
}

interface TestCaseStepDefinition {
  id: string;
  prompt: string;
  timeoutMs?: number;
  args?: string[];
  env?: string[];
  config?: Record<string, unknown>;
  mocks?: TestCaseMockConfig;
  assert?: AssertionConfig[];
}

interface ScenarioRunContext {
  scenarioId: string; // same value as testCase.id
  testCaseId: string;
  agentName: string;
  runDir: string;
  workspaceDir: string;
  configDir: string;
  continuation?: AdapterContinuation;
}

interface ScenarioStepResult {
  id: string;
  status: ScenarioStepStatus;
  output: string;
  events: AgentEventsSummary;
  assertions: AssertionResult[];
  scores: ScoreResult[];
  cost: CostSummary;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error?: string;
}
```

### Adapter continuation contract

The runner passes test case, step identity, and prior continuation metadata to the adapter. The adapter returns a run plan plus updated continuation metadata when it needs state for the next step. The continuation object is opaque to the runner.

```ts
interface AgentStepPrepareInput extends AgentPrepareInput {
  testCase: TestCaseDefinition;
  step: TestCaseStepDefinition;
  stepIndex: number;
  continuation?: AdapterContinuation;
}

interface AgentStepRunPlan extends AgentRunPlan {
  continuation?: AdapterContinuation;
}

interface AdapterContinuation {
  id?: string;
  metadata?: Record<string, unknown>;
}
```

## 3. Lifecycle / State Transitions

```text
pending
  -> preparing-workspace
  -> running-step
  -> evaluating-assertions
  -> running-step | completed | failed | timeout | error
```

Step-level state transitions:

```text
pending
  -> skipped    when a previous required assertion failed
  -> running
  -> passed     when required assertions pass
  -> failed     when required assertions fail
  -> timeout
  -> error
```

Rules:

1. The workspace is copied once per `(test case, agent)` run, not once per step, so later steps observe earlier step changes.
2. The runner stores and passes adapter continuation metadata without interpreting it.
3. The adapter decides how to continue between steps: native session ID, transcript replay, CLI-specific context, or no extra state beyond the shared workspace.
4. A required assertion failure stops later steps and marks them `skipped`.
5. Non-required assertions and score aggregation failures do not advance or stop the lifecycle.
6. One-shot test cases are normalized into a single step before execution.

## 4. Read Path / Write Path

### Read path

1. Read `tests` glob patterns from `harness-evals.yaml`, or use `evals/tests/**/*.yaml` when omitted.
2. Load one test case from each matched YAML file.
3. Normalize one-shot test cases into a single-step shape.
4. Resolve test-case and step mock declarations.
5. Resolve agent selection and matrix entries.
6. Resolve the adapter for each selected agent.
7. Read previous step results only from the in-memory run context, not from persisted output records.

### Write path

1. Create one output context for the test-case/agent pair.
2. Copy source workspace or fixture once for the test-case run.
3. For each step, stage mocks when declared, emit mock config/call records, logs, and normalized step output records.
4. After the final step or stop condition, emit workspace diff, score summary, cost summary, and result records.
5. Let configured output providers persist the records.
6. Remove adapter-declared cleanup paths before the run finishes.

## 5. Failure Modes

| Failure mode | Symptom | Detection | Remediation |
| --- | --- | --- | --- |
| Test glob matches no files | No test cases are loaded from that pattern | File glob resolution | Fix the `tests` pattern or add files under `evals/tests/` |
| Test file escapes project root | Config load fails | Path traversal guard | Use project-relative test paths only |
| Required assertion fails | Later steps are skipped | Assertion result | Inspect `steps/<step-id>/assertions.json` and workspace diff |
| Step timeout | Step status is `timeout`; test case stops | Docker runner timeout | Increase step or test-case timeout, or simplify the prompt |
| Adapter continuation fails | Step status is `error` or adapter returns invalid continuation metadata | Adapter contract validation | Adapter should surface a clear error and include continuation metadata where available |
| Output provider failure | Scenario result persistence is incomplete | Output provider write error | Fail fast for the default file provider; record secondary provider failure when file output succeeds |
| Judge assertion failure | Step fails when the judge assertion is required; otherwise the finding is recorded | Assertion result | Inspect judge rationale and threshold |
| Score aggregation failure | Score summary is incomplete but required assertions may still pass | Score bucket status | Mark the bucket unavailable with rationale; do not hide assertion status |

## 6. Trade-Offs Accepted

- Individual YAML files keep test cases easy to review, select, and move between projects.
- `harness-evals.yaml` owns test selection, while test case files own prompts, steps, mocks, and assertions.
- Linear step order is the default test-case model because it covers gated prompt chains without introducing a workflow engine.
- The workspace persists across steps; adapter continuation metadata adds agent-specific context when needed.
- Continuation semantics differ by agent and belong inside adapters.
- Step output is emitted as separate records so providers can store large logs and judge outputs without inflating the top-level result JSON.

## 7. Design Decisions

### Accepted decisions

- A test case can contain one step or many steps.
- Test cases are individual YAML files by default under `evals/tests/`.
- Omitting `tests` in `harness-evals.yaml` loads `evals/tests/**/*.yaml`.
- Explicit `tests` glob patterns in `harness-evals.yaml` override default discovery.
- Required assertions control whether later steps run.
- Multi-step continuation is adapter-owned and represented by opaque continuation metadata.
- The workspace is copied once per test-case/agent run and shared by all steps in that run.
- The test case schema does not define adapter continuation policy fields.

### Open decisions

- Whether first-release test cases support only linear step order or also named branches.
- Whether a step can reference prior step outputs through templating, or only through adapter continuation metadata and workspace state.
