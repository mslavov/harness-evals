# Concepts

This page is the mental model for reading and writing evals in `harness-evals`.

## In one sentence

A run builds a matrix of test cases × agents, gives each selected agent a workspace in Docker, executes one or more steps, evaluates assertions, and writes artifacts plus reports.

## Glossary

### Test case

A test case is one YAML file that defines what an agent should do and how success is checked.

A test case has an `id` and can also include:

- `description`
- `suite`
- `workspace`
- `agents` selection and overrides
- `mocks`
- `verifier`
- `attempts`
- `timeoutMs`
- one-step fields like `prompt` and `assert`
- or an explicit `steps:` array for multi-step runs

One-step cases are normalized into a single step with id `run`.

### Suite

A suite is just a label on a test case, for example `smoke` or `checkout`. Use it to group cases and filter runs with `--suite`.

### Step

A step is one prompt-driven turn inside a test case.

Each step has:

- `id`
- `prompt`
- `assert`
- optional `timeoutMs`
- optional step-scoped `args`, `env`, `config`, `mocks`

Steps run in order. In multi-step cases they share the same workspace, so later steps see earlier file changes.

### Agent

An agent is a named runtime profile in `harness-evals.yaml`, such as `pi-gemini` or `claude-sonnet`.

An agent config chooses an adapter and may also define:

- `command`, `args`, `cwd`
- `provider`, `model`, `profile`
- `apiKeyEnv`
- `env`, `envAllowlist`
- `timeoutMs`
- `parser`
- adapter-specific `config`
- `extends` to inherit from another agent

Think of an agent as a reusable preset for how to invoke one coding agent.

### Adapter

An adapter is the integration layer between the harness and an agent CLI.

It is responsible for things like:

- building the command to run for a step
- mapping config into argv, env, and mounted config
- parsing the agent output into structured events
- optionally handling headless string-in/string-out completions for judge fallback
- optionally installing MCP mocks for agents that support them

Built-in adapters include:

- `command`
- `pi`
- `claude-code`
- `codex`
- `cursor`

Projects can also register custom adapters.

### Workspace

A workspace is the file tree the agent sees during a run.

By default the harness copies `workspace.source` into a run-local workspace directory and mounts it into Docker at `/workspace`.

Important points:

- runs do not edit your source tree directly
- ignore patterns are applied during copy and diffing
- a test case can point at a fixture directory instead of the default source
- a case can set `workspace.seedFromImage` to seed the workspace from a path inside the Docker image (default `/app`, including `.git`) instead of copying a source — for tasks whose repo ships in the image
- multi-step cases reuse the same copied workspace across steps

### Assertion

An assertion is a rule that decides whether a step passed.

Built-in assertion types include:

- `exitCode`
- `contains`
- `notContains`
- `toolCalled`
- `mockCalled`
- `noToolErrors`
- `workspaceDiff`
- `settingsDrivenSetup`
- `llmJudge`

Assertions are attached to steps. Required assertions default to `true` unless you set `required: false`.

### Verifier

A verifier is an optional post-agent command that runs after all agent steps finish.

Use it for checks that are easier to express as code than as step assertions, including hidden tests. A verifier can parse a numeric `reward.txt` or `reward.json`, apply a hidden patch before running, and write verifier artifacts under the run directory. It can also mount a directory of hidden grading material read-only into the verifier container only via `verifier.assetsDir` (default target `/tests`), keeping those files out of the agent's workspace.

### Attempt

An attempt is one repeated execution of the same case/agent/model combination.

Set `attempts` on a case or pass `--attempts` to the CLI. When attempts have binary verifier rewards, harness-evals reports pass@k summaries.

### Hidden patch and model patch

When `verifier.hiddenPatch` is set, harness-evals captures `model.patch` from the agent-edited workspace first, then applies the hidden patch only inside the copied run workspace before the verifier runs.

### Mock

A mock is a deterministic replacement for an external dependency.

`harness-evals` supports:

- CLI mocks
- MCP mocks

Mocks can be defined at the test-case level and overridden per step.

Default behavior is strict:

- referenced mock fixtures are loaded from `mocks.root`
- unmatched mocked calls fail the step when strict mode is on
- mock calls are recorded by default

### Output

Outputs are the files and records produced while a run executes.

Examples include:

- `records.jsonl`
- `result.json`
- `summary.json`
- `score-summary.json`
- `cost-summary.json`
- `workspace-diff.json`
- step logs and per-step JSON artifacts
- report files such as HTML, JSON, and CSV

The default output provider writes these to disk.

### Report

A report is the summarized view of run results.

Reports are built from run output records and can be written in:

- `html`
- `json`
- `csv`

There are two common views:

- per-run artifacts under `artifactRoot/<run-id>/`
- latest summary artifacts under `outputRoot/latest/`

### Scoring

Scoring turns raw results into weighted metrics for comparison.

Available score types:

- `assertionPassRate`
- `judgeScore`
- `verifierReward`
- `latency`
- `cost`
- `tokenUsage`

Each score type has a `weight`. Metric scores can also define:

- `target`: `maximize` or `minimize`
- `best`
- `worst`

By default assertion pass rate, judge score, and verifier reward are weighted when present; latency, cost, and token usage are present with weight `0`.

## How a run fits together

### 1) Load config and test cases

The loader reads `harness-evals.yaml`, applies defaults, discovers test case YAML files from `tests`, and normalizes one-step cases into a single `run` step.

### 2) Build the execution matrix

The harness expands selected test cases against selected agents and configured attempts.

You can narrow the matrix with:

- `--case`
- `--suite`
- `--agents`
- test-case `agents.include`
- test-case `agents.exclude`

### 3) Prepare the runtime

For each case/agent pair, the harness:

- creates a run directory
- copies the workspace
- prepares Docker arguments
- resolves the adapter
- applies agent, test-case, and CLI overrides

### 4) Execute steps

Each step runs in order.

The adapter prepares the concrete command, env vars, parser, config mounts, and optional mock plumbing. The harness captures stdout/stderr, structured events, mock calls, workspace changes, and assertion results.

### 5) Score and report

After execution, the harness computes assertions, optional judge scores, summary metrics, and report artifacts.

If a verifier is configured, it runs after agent steps and before the final run result is written. Verifier status and reward participate in run pass/fail and scoring.

## Practical mental model

When authoring evals, think in this order:

1. Which workspace should the agent start from?
2. Which agent presets should run?
3. Is this one turn or multiple steps?
4. What needs to be mocked?
5. Which assertions prove success?
6. Do you need a post-agent verifier or hidden tests?
7. Which metrics matter for comparison?

## Typical file layout

```text
harness-evals.yaml
evals/
  tests/
  mocks/
  fixtures/
.harness-evals/
  runs/
  output/
```

## What to optimize for

Good evals are:

- specific enough for deterministic assertions
- small enough to run often
- isolated from external systems unless intentionally tested
- comparable across multiple agents
- easy to inspect from artifacts and reports
