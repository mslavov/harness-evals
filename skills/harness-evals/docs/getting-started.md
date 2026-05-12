# Getting started

This guide gets you to a first successful run and shows the core CLI loop:

1. initialize a harness project
2. list discovered agents and cases
3. run one case
4. view the report
5. export a report file

## Before you start

If you installed the skill first, let your coding agent check whether the CLI is installed and ask whether to install it globally or locally if it is missing.

The examples below use `harness-evals`. If the CLI is installed locally, run the same commands through your package runner, such as `npx harness-evals`, `pnpm exec harness-evals`, or `bunx harness-evals`.

The generated starter config does not require agent credentials. It uses the built-in `command` adapter with a local `echo` command, so you can validate the harness before wiring up real agents.

## 1. Initialize the starter project

From the repo or directory you want to evaluate:

```bash
harness-evals init
```

This creates:

- `harness-evals.yaml`
- `evals/tests/starter-smoke.yaml`

The starter config uses these defaults:

- artifacts in `.harness-evals/runs`
- latest reports in `.harness-evals/output/latest`
- test discovery from `evals/tests/**/*.yaml`
- a starter agent named `local-command`

If you want the config somewhere else, pass `--config`:

```bash
harness-evals init --config ./config/harness-evals.yaml
```

## 2. List agents, cases, and matrix size

```bash
harness-evals list
```

You should see:

- the configured agents, including `local-command`
- the discovered cases, including `starter-smoke`
- the total matrix entry count
- whether the run will use a ready Docker image or an automatically managed one

## 3. Run the starter case

```bash
harness-evals run --case starter-smoke --agents local-command
```

What this does:

- copies the configured workspace into a Docker workspace
- runs the selected agent against the selected case
- evaluates assertions from the test case
- writes run artifacts and the latest summary report

A passing starter run exits with code `0`. A failing run exits with code `1` and still writes artifacts for inspection.

## 4. View the report

To print the latest HTML report path:

```bash
harness-evals view
```

To open it directly:

```bash
harness-evals view --open
```

To serve reports on a local port:

```bash
harness-evals view --port 3000 --open
```

You can also target a specific run if you know its run id:

```bash
harness-evals view --run <run-id>
```

Per-run HTML lives at:

- `.harness-evals/runs/<run-id>/index.html`

The latest aggregated HTML report lives at:

- `.harness-evals/output/latest/results.html`

## 5. Export a report file

Export the latest report in one of the enabled visualization formats:

```bash
harness-evals export --format html --output ./artifacts/results.html
harness-evals export --format json --output ./artifacts/results.json
harness-evals export --format csv --output ./artifacts/results.csv
```

To export a specific run instead of the latest summary:

```bash
harness-evals export --run <run-id> --format json --output ./artifacts/run.json
```

`--format` must be one of `html`, `json`, or `csv`, and that format must be enabled in `visualization.formats`.

## What to inspect after a run

Useful generated paths:

- `.harness-evals/output/latest/results.html`
- `.harness-evals/output/latest/results.json`
- `.harness-evals/output/latest/results.csv`
- `.harness-evals/runs/<run-id>/result.json`
- `.harness-evals/runs/<run-id>/steps/<step-id>/stdout.log`
- `.harness-evals/runs/<run-id>/steps/<step-id>/assertions.json`

## Next steps

After the starter run passes, the usual next moves are:

- replace `local-command` with one or more real agents
- add new cases under `evals/tests/`
- split cases into suites and run them with `--suite`
- add mocks under `evals/mocks/` for deterministic external behavior

For practical patterns, continue to [Use cases](./use-cases.md).
