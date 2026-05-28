# Writing evals

Use one YAML file per test case. By default harness-evals loads `evals/tests/**/*.yaml`.

Start from the behavior the user wants to preserve or compare. Before writing YAML, identify the task, starting workspace, agents to compare, success criteria, and whether the scenario comes from a new prompt, existing session, real failure, or repeated workflow.

## Minimal test case

```yaml
id: readme-update
suite: docs
prompt: Update the README quick-start section to mention the new install command.
assert:
  - type: exitCode
    equals: 0
  - type: workspaceDiff
    changedFiles: [README.md]
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
attempts: 2
verifier:
  command: bun
  args: [test]
  rewardFile: reward.txt
  hiddenPatch: evals/hidden/checkout.patch
  network:
    mode: none
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
- `verifier`: optional post-agent verifier command and reward parser.
- `attempts`: optional positive integer repeat count for this case.
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

## Post-agent verifiers and hidden tests

Use `verifier` when pass/fail depends on checks that should run after the agent finishes, such as hidden tests.

```yaml
verifier:
  command: bun
  args: [test, --runInBand]
  rewardFile: reward.txt
  rewardFormat: text
  hiddenPatch: evals/hidden/my-case.patch
  captureModelPatch: true
  network:
    mode: none
```

Verifier fields:

- `command`: required command to run in the same Docker image as the agent.
- `args`: optional command arguments.
- `cwd`: optional working directory inside the container. Relative values are resolved under the workspace container path.
- `env`: optional explicit environment variables to forward to the verifier.
- `timeoutMs`: optional verifier timeout.
- `rewardFile`: optional workspace-relative file produced by the verifier.
- `rewardFormat`: `auto`, `text`, or `json`. Text rewards are parsed as `{ reward: number }`; JSON rewards must be a numeric reward map.
- `hiddenPatch`: optional project-relative patch applied after agent changes are captured and before the verifier runs.
- `captureModelPatch`: writes `model.patch` before hidden tests are applied.
- `network`: verifier network policy. Omit it to run the verifier with `mode: none`.

When a verifier is configured, the run passes only if the agent steps pass and the verifier passes. A numeric reward of `0` fails the verifier; a positive reward passes it.

Hidden patches are applied to the copied run workspace, not your source repo. `model.patch` captures the agent changes before the hidden patch is applied, so hidden test content stays out of the model patch artifact.

## Attempts and pass@k

Set `attempts` on a case to repeat each selected case/agent/model combination:

```yaml
id: flaky-repair
attempts: 5
prompt: Fix the failing test.
verifier:
  command: bun
  args: [test]
  rewardFile: reward.txt
```

Pass@k is computed when repeated attempts have binary verifier rewards (`0` or `1`). Missing verifier rewards count as non-successes; non-binary reward maps make the pass@k group ineligible.

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
- `verifier/result.json`, `verifier/reward.json`, and verifier logs when a verifier is configured
- `model.patch` and `hidden-patch.json` when hidden-test patching is configured

Those files are useful when tightening assertions or debugging a flaky case.
