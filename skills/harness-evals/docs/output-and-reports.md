# Output and reports

Harness-evals writes per-run artifacts and a rolling latest summary through the built-in file output provider.

## File output provider

If you do not configure output providers, harness-evals uses the built-in `file` provider.

Default roots:

- run artifacts: `.harness-evals/runs`
- latest summaries and exports: `.harness-evals/output`

The file provider is also the provider that renders the built-in visualizations.

## Artifact layout

Each scenario/agent run gets its own directory under `artifactRoot`:

```text
.harness-evals/runs/
  <case>-<agent>-<timestamp>-<n>/
```

Common files in a run directory:

- `records.jsonl`: every emitted output record, in order
- `run-started.json`
- `image-resolution.json`
- `workspace-diff.json`
- `score-summary.json`: scenario-level score summary
- `cost-summary.json`: scenario-level cost summary
- `result.json`: full run result
- `summary.json`: compact run summary
- `finalize.json`: provider finalize status
- `index.html`: per-run HTML report when HTML visualization is enabled
- `mock-config.json` and `mock-calls.jsonl` when mocks are used

Per-step files live under `steps/<step-id>/`:

- `step-started.json`
- `command.redacted.json`
- `stdout.log`
- `stderr.log`
- `events-summary.json`
- `assertions.json`
- `score.json`
- `cost.json`
- `step-completed.json`
- `mock-config.json` and `mock-calls.jsonl` for step-scoped mocks
- `judges/<assertion-id>.json` for `llmJudge` results

Step ids are sanitized for artifact paths, so use stable, distinct step ids.

## Latest summary

After a run finishes, harness-evals writes a latest report set under:

```text
.harness-evals/output/latest/
```

By default it writes:

- `results.html`
- `results.json`
- `results.csv`

The summary content is built from the full run results and includes pass/fail counts, average score, duration, cost, token usage, per-case rows, and per-agent columns.

## Visualization formats

Built-in visualization formats are:

- `html`
- `json`
- `csv`

Default config:

```yaml
visualization:
  enabled: true
  formats: [html, json, csv]
  latest: true
```

Notes:

- per-run `index.html` is generated only when `html` is enabled
- latest files are generated only when `visualization.enabled` and `visualization.latest` are both true
- if you limit `formats`, only those files are written

You can also control detail sections included in reports:

```yaml
visualization:
  include:
    logs: true
    workspaceDiff: true
    toolCalls: true
    mockCalls: true
    judgeDetails: true
```

These switches affect the rendered report content, not the underlying artifacts.

## View reports

Use the CLI to locate or serve reports:

```bash
harness-evals view
harness-evals view --run <run-id>
harness-evals view --open
harness-evals view --port 3000
```

Behavior:

- without `--run`, `view` targets `output/latest/results.html`
- with `--run`, it targets `<artifactRoot>/<run-id>/index.html`
- with `--port`, it serves `/latest/...` and `/runs/...` over a local HTTP server
- with `--open`, it opens the resolved file or local URL

If the expected HTML file is missing, `view` fails with `Report not found: ...`.

## Export reports

Use `export` to copy or render one report file:

```bash
harness-evals export --format json --output report.json
harness-evals export --run <run-id> --format csv --output report.csv
```

Behavior:

- exporting latest copies `output/latest/results.<format>`
- exporting a specific run reads `<artifactRoot>/<run-id>/result.json` and renders the requested format on demand

`export` requires:

- `--format html|json|csv`
- `--output <path>`
- visualization enabled for the requested format

If a format is not enabled, the CLI fails with `Visualization format is not enabled: ...`.

## What the HTML report is for

The built-in HTML report is a triage view.

It shows:

- one column per agent/provider/model combination
- one row per test case
- status, score, duration, cost, tokens, and assertion summary per cell
- expandable details for steps, failed assertions, tool calls, mock calls, judge results, workspace diff, and log links when included

Use the raw JSON artifacts when you need machine-readable detail; use HTML or CSV for comparison and review.