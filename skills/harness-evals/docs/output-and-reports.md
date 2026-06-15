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
- `model.patch` when model patch capture is enabled
- `hidden-patch.json` when a hidden patch is applied

Verifier files live under `verifier/` when a case has `verifier`:

- `verifier-started.json`
- `command.redacted.json`
- `stdout.log`
- `stderr.log`
- `reward.json` when a reward file is parsed
- `result.json`

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

The summary content is built from the full run results and includes pass/fail counts, average score, duration, cost, token usage, pass@k summaries when eligible, per-case rows, and per-agent columns.

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

## Aggregate report (default `view`)

`harness-evals view` with no `--run`/`--latest` scans every run directory in
the workspace and writes one self-contained interactive report to
`<outputRoot>/report/index.html`, then opens it (suppress with `--no-open`).

How it works:

- Every `harness-evals run` invocation stamps a **batchId** into each run
  directory it creates (`summary.json.batchId`, plus full metadata under
  `run-started.json.batch`). The report's "Runs" selector lists batches
  newest-first; the newest is pre-selected.
- Selecting several batches merges them, keeping the **newest graded attempt**
  per (case, agent): a passed/failed/skipped/timeout verdict always beats an
  error/incomplete run, regardless of recency.
- Runs from versions before batch stamping are grouped into synthetic
  `legacy-<date>` batches derived from the run directory timestamp.
- The scanner reads only `summary.json` and `run-started.json` (never the
  potentially huge `result.json`). Corrupt or partial run dirs become scan
  warnings; a dir with only `run-started.json` shows as `incomplete`.
- All run data is embedded in the HTML, so batch/agent/suite/status filters
  and a disagreements-only toggle re-aggregate live — the file works offline,
  from `file://`, and survives being mailed around.

The report shows per-agent KPI cards (solve rate with 95% Wilson interval,
average time, total and per-task cost, tokens), solve-rate bars (overall and
per suite), a cost-vs-solve-rate scatter, an agent × task matrix with
pass/fail dots and in-cell cost/duration micro-bars (click a cell for attempt
details and a link to the run's own report), duration and cost strip plots,
and a cached/input/output token composition bar — all hand-rolled inline SVG,
no external scripts.

`summary.json` now also records `suite` and `description` per run, so suite
grouping works without re-reading test configs.

## View reports

```bash
harness-evals view                       # aggregate report, opens browser
harness-evals view --no-open             # just write + print the path
harness-evals view --batch all           # pre-select every batch
harness-evals view --run <run-id>        # one run's index.html (back-compat)
harness-evals view --latest              # last invocation's results.html
harness-evals view --port 3000           # serve /report, /runs, /latest
```

Behavior:

- default: regenerate `<outputRoot>/report/index.html` from a workspace scan
  and open it; `--batch`, `--agents`, `--suite`, `--status` pre-set the
  report's filters (all data stays embedded)
- with `--run`, it targets `<artifactRoot>/<run-id>/index.html`
- with `--latest`, it targets `output/latest/results.html`
- with `--port`, it serves `/report/...`, `/latest/...` and `/runs/...` over a
  local HTTP server (run links in the aggregate report resolve automatically)

If an expected HTML file is missing, `view` fails with `Report not found: ...`.

## Export reports

```bash
harness-evals export --format csv --output report.csv                    # newest batch
harness-evals export --batch all --format json --output everything.json  # whole workspace
harness-evals export --batch b1,b2 --agents claude,pi --format html --output cmp.html
harness-evals export --latest --format json --output report.json         # copy last summary
harness-evals export --run <run-id> --format csv --output report.csv     # single run
```

Behavior:

- default exports the **aggregate**: scans the workspace, applies `--batch`
  (default `latest`; `all` or a comma list also allowed), `--agents`,
  `--suite`, `--case`, `--status` server-side; merging several batches
  dedupes to the newest graded attempt per (case, agent). `html` stays
  interactive; `csv` is one row per task run (batch, suite, models, status,
  duration, cost, token split); `json` is the embedded data model.
- `--latest` copies `output/latest/results.<format>` verbatim
- `--run` reads `<artifactRoot>/<run-id>/result.json` and renders on demand

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
- expandable details for steps, failed assertions, tool calls, mock calls, judge results, verifier results, workspace diff, and log links when included

Use the raw JSON artifacts when you need machine-readable detail; use HTML or CSV for comparison and review.
