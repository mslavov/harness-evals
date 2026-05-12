# Writing evals

Use one YAML file per test case. By default harness-evals loads `evals/tests/**/*.yaml`.

## Minimal test case

```yaml
id: starter-smoke
suite: smoke
prompt: Reply with HARNESS_EVALS_OK and do not edit files.
assert:
  - type: contains
    value: HARNESS_EVALS_OK
  - type: workspaceDiff
    changedFiles: []
```

If you omit `steps`, harness-evals creates a single step with id `run`.

## Test case structure

```yaml
id: checkout-refactor
description: Refactor checkout flow with a plan-first flow.
suite: refactors
workspace:
  fixture: evals/fixtures/checkout
agents:
  include: [pi-gemini]
  exclude: [local-command]
  overrides:
    "*":
      model: gemini-2.5-pro
mocks:
  cli:
    jira-cli: jira-success
  strict: true
steps:
  - id: plan
    prompt: Review the checkout flow and propose a minimal refactor plan.
    assert:
      - type: contains
        value: refactor
  - id: implement
    prompt: Implement the approved refactor.
    timeoutMs: 120000
    args: [--dangerously-skip-permissions]
    env: [FEATURE_FLAG]
    config:
      mode: edit
    assert:
      - type: exitCode
        equals: 0
      - type: workspaceDiff
        minChanged: 1
  - id: verify
    prompt: Run checks and fix issues.
    assert:
      - type: noToolErrors
```

Supported top-level fields:

- `id`: required, unique case id.
- `description`: optional human-readable summary.
- `suite`: optional label for `--suite` filtering.
- `workspace`: optional per-case workspace override.
- `agents`: optional include/exclude/override selection.
- `mocks`: optional case-level mock declarations.
- `steps`: ordered multi-step scenario.
- `timeoutMs`: default timeout for a generated single step.
- `prompt`, `assert`, `args`, `env`, `config`, `parser`: shorthand for single-step cases.

## Suites

`suite` is just a string on the test case. Use it to group cases like `smoke`, `refactors`, or `regression`, then run a subset with `--suite`.

## Multi-step scenarios

Steps run in order and share the same copied workspace. A later step sees files created or edited by earlier steps.

Each explicit step requires:

- `id`
- `prompt`

Optional step fields:

- `assert`
- `timeoutMs`
- `args`
- `env`
- `config`
- `mocks`

Step ids are sanitized for artifact paths, so keep them distinct even after lowercasing and replacing spaces/symbols with `-`.

Step-level overrides merge with the selected agent config:

- `args` are appended to agent args
- `env` is unioned with agent env
- `config` is shallow-merged over agent config

If a required assertion fails, later steps are skipped.

## Workspace and fixtures

The runner copies a source workspace into a per-run workspace directory before the first step.

Defaults come from `harness-evals.yaml`:

- `workspace.source`: base repo or fixture to copy
- `workspace.mode`: `copy`
- `workspace.containerPath`: default `/workspace`
- ignored by default: `.git`, `node_modules`, `.harness-evals`, `.pi-evals`, `evals/output`

Per test case, you can override:

```yaml
workspace:
  source: app
```

or point at a smaller fixture:

```yaml
workspace:
  fixture: evals/fixtures/checkout
```

`workspace.fixture` is often the best choice for focused evals because each run starts from a stable snapshot.

## Assertion examples

Built-in assertions used in cases and steps:

### Output

```yaml
assert:
  - type: contains
    value: HARNESS_EVALS_OK
  - type: notContains
    value: stack trace
  - type: exitCode
    equals: 0
```

### Tool usage

```yaml
assert:
  - type: toolCalled
    name: functions.read
    min: 1
  - type: toolCalled
    name: functions.edit
    max: 3
    argsContain: [package.json]
```

`name` matches the tool/event name. `argsContain` checks the serialized call args.

### Mock usage

```yaml
assert:
  - type: mockCalled
    name: jira-cli:issue
    surface: cli
    matched: true
    argsContain: [STORZY]
```

### Workspace changes

```yaml
assert:
  - type: workspaceDiff
    changedFiles: [src/checkout.ts]
```

```yaml
assert:
  - type: workspaceDiff
    addedFiles: [notes/plan.md]
    deletedFiles: []
```

```yaml
assert:
  - type: workspaceDiff
    minChanged: 1
    maxChanged: 5
```

`workspaceDiff` compares the entire run workspace before the first step with the workspace state after the current step.

### Error-focused checks

```yaml
assert:
  - type: noToolErrors
```

## Optional assertions

Every assertion is `required: true` by default. Set `required: false` when you want to record a signal without failing the step.

```yaml
assert:
  - type: toolCalled
    name: functions.read
    min: 5
    required: false
```

## What to expect in artifacts

For each run, harness-evals writes a run directory under `.harness-evals/runs/...` with:

- `result.json`
- `workspace/`
- `steps/<step-id>/stdout.log`
- `steps/<step-id>/events-summary.json`
- `steps/<step-id>/assertions.json`
- `steps/<step-id>/step-completed.json`

Those files are useful when tightening assertions or debugging a flaky case.
