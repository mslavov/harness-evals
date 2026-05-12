# Use cases

These workflows map common evaluation goals to concrete `harness-evals` patterns.

## Compare agents on the same task

Use this when you want an apples-to-apples comparison across agents.

1. Define multiple agents in `harness-evals.yaml`.
2. Create one or more shared test cases under `evals/tests/`.
3. Run the same case against selected agents.
4. Inspect the latest HTML, JSON, or CSV report.

Example agent set:

- `pi`
- `claude-code`
- `codex`
- `cursor`
- `command` for simple local command baselines

Typical command:

```bash
harness-evals run --case checkout-refactor --agents pi-gemini,claude-sonnet,codex-gpt
```

Use this for prompt quality checks, task success comparisons, and score tracking across model changes.

## Create a regression suite from real failures

Use this when a bug, bad edit, or missed instruction should never recur.

Recommended workflow:

1. create a case in `evals/tests/` that reproduces the failure
2. keep the prompt and workspace fixture as small as possible
3. add assertions for the failure boundary
4. group similar cases with `suite`
5. rerun that suite after agent or prompt changes

Common assertions for regression cases:

- `contains`
- `notContains`
- `exitCode`
- `workspaceDiff`
- `noToolErrors`

Example:

```yaml
id: checkout-regression
suite: regressions
workspace:
  fixture: evals/fixtures/checkout
prompt: Fix the checkout total bug without changing public APIs.
assert:
  - type: exitCode
    equals: 0
  - type: workspaceDiff
    minChanged: 1
```

Then run:

```bash
harness-evals run --suite regressions
```

## Validate repo-specific behavior

Use this when success depends on the actual repository state, not just text output.

Good fits:

- an agent should edit a specific file
- a refactor should touch some files but not others
- a cleanup task should leave no unexpected changes
- a multi-step workflow should plan, implement, then polish

Useful harness features:

- `workspace.source` to copy the repo into the container workspace
- `workspace.fixture` on a case to start from a narrower fixture
- multi-step cases with `steps:`
- `workspaceDiff` assertions to verify changed, added, or deleted files

A common pattern is a three-step case:

- `plan`
- `implement`
- `polish`

That keeps the prompt sequence explicit and gives you per-step artifacts.

## Mock external tools and MCP servers

Use this when a case depends on unstable or unsafe external systems.

`harness-evals` supports:

- CLI mocks under `mocks.cli`
- MCP mocks under `mocks.mcp`
- fixture files under `evals/mocks/cli/` and `evals/mocks/mcp/`

CLI mock example:

```yaml
mocks:
  cli:
    jira-cli: jira-success
```

MCP mock example:

```yaml
mocks:
  mcp:
    github: github-success
```

Why mock:

- keep runs deterministic
- avoid network and service flakiness
- validate tool usage without touching real systems
- assert on mock activity with `mockCalled`

In strict mode, unmatched mock calls fail the run. That is useful when a case should only use approved external interactions.

## Triage failures quickly

When a run fails, inspect artifacts before changing the case.

Start with:

```bash
harness-evals view --open
```

Then inspect the failing run directory:

- `.harness-evals/runs/<run-id>/result.json`
- `.harness-evals/runs/<run-id>/workspace-diff.json`
- `.harness-evals/runs/<run-id>/steps/<step-id>/stdout.log`
- `.harness-evals/runs/<run-id>/steps/<step-id>/stderr.log`
- `.harness-evals/runs/<run-id>/steps/<step-id>/assertions.json`
- `.harness-evals/runs/<run-id>/mock-calls.jsonl`

Useful questions during triage:

- Did the agent fail the task, or is the assertion too strict?
- Did the wrong agent set run because of `--agents`, case filters, or config inheritance?
- Did the workspace fixture omit files the task actually needs?
- Did a strict mock reject a call that should have been declared?
- Did the case need step-level assertions instead of one final assertion block?

If you need a portable artifact for CI or sharing, export the latest report:

```bash
harness-evals export --format json --output ./artifacts/latest-results.json
```

## Build a focused smoke suite

Keep a small `smoke` suite for fast feedback.

A good smoke suite:

- uses small fixtures
- avoids judge-heavy cases unless necessary
- checks the most important workflows only
- runs on every adapter or prompt change

Then use:

```bash
harness-evals run --suite smoke
```

Use broader regression suites less often, and smoke suites constantly.
