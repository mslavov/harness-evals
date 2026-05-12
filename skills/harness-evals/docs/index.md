# Harness evals

`harness-evals` is a Docker-based evaluation harness for coding agents. It runs real agent CLIs in isolated workspaces, applies assertions to their behavior, and writes reports you can compare over time.

Use it when you want to:

- compare two or more agents on the same task
- turn a bug report or workflow into a repeatable regression test
- verify repo-specific behavior such as file edits, command output, or tool usage
- replace external CLI or MCP dependencies with deterministic mocks
- keep run artifacts and shareable HTML/JSON/CSV reports

## Quick start paths

### I am setting up a project through an agent

Start with [Installation and configuration](./installation-and-configuration.md). The expected flow is: install the skill, ask your coding agent to set up evals, let it check or install the CLI, then let it create the first focused eval with you.

### I want a first passing run

Start with [Getting started](./getting-started.md).

### I want practical evaluation workflows

See [Use cases](./use-cases.md).

### I want to author or refine evals

- [Writing evals](./writing-evals.md)
- [Scoring and judging](./scoring-and-judging.md)
- [Mocks](./mocks.md)

### I want to configure agents and adapters

- [Installation and configuration](./installation-and-configuration.md)
- [Agents and adapters](./agents-and-adapters.md)
- [Docker workspaces and images](./docker-workspaces-and-images.md)

### I want to inspect results

- [Output and reports](./output-and-reports.md)
- [CLI reference](./cli-reference.md)
- [Troubleshooting](./troubleshooting.md)

## What a harness project contains

A minimal project usually has:

- `harness-evals.yaml` for project config
- `evals/tests/**/*.yaml` for test cases
- `evals/mocks/` for optional CLI and MCP mock fixtures
- `.harness-evals/runs/` for per-run artifacts
- `.harness-evals/output/latest/` for the latest aggregated report

The built-in starter created by `harness-evals init` uses a `local-command` agent with the `command` adapter and a `starter-smoke` case under `evals/tests/starter-smoke.yaml`.

## Common tasks

### Compare agents on the same task

Define multiple agents in `harness-evals.yaml`, then run:

```bash
harness-evals run --case starter-smoke --agents pi,claude,codex
```

### Run a single suite or case during development

```bash
harness-evals run --suite smoke
harness-evals run --case checkout-refactor
```

### Inspect available agents and cases

```bash
harness-evals list
```

### Open the latest report

```bash
harness-evals view --open
```

### Export a report artifact

```bash
harness-evals export --format json --output ./artifacts/latest-results.json
```

## When not to use it

`harness-evals` is most useful when you need repeatable, comparable agent runs. If you only need a one-off manual prompt run, using the agent directly is usually faster.
