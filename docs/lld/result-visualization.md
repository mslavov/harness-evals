# LLD — Result Visualization

> **HLD:** `../HDL.md`
> **Companion LLDs:** `agent-first-install-and-config.md`, `scenario-runner.md`, `adapter-registry-and-contract.md`, `managed-images.md`, `validation-scoring-and-judging.md`, `cost-and-artifacts.md`, `output-providers.md`, `mock-mcps-and-clis.md`
> **Status:** Draft

## How this fits

This LLD defines the result visualization layer. It consumes normalized output records and file-provider artifacts to produce promptfoo-style result views: static HTML reports, JSON/CSV exports, and a local viewer command for inspecting latest and historical runs.

Visualization is not the source of truth for run data. Output records and provider artifacts remain authoritative. Visualization is a read model optimized for humans comparing test cases, agents, models, assertions, scores, cost, latency, tool calls, mock calls, and workspace diffs.

## 1. Domain Overview

A harness run can produce hundreds of step records, logs, diffs, assertions, judge outputs, cost reports, and mock call records. Raw JSON artifacts are good for automation but poor for triage. The visualization layer turns the same data into shareable and navigable reports.

The first implementation provides file-based reports similar to promptfoo's HTML output and web viewer:

- A static `results.html` table for the latest run.
- A machine-readable `results.json` and spreadsheet-friendly `results.csv`.
- A per-run `index.html` with detailed test-case/agent/step pages or sections.
- A `harness-evals view` command that opens the latest report or serves a local viewer.

The report emphasizes comparison. Rows represent test cases. Columns represent selected agents/models. Cells summarize pass/fail/error, score, duration, cost, token usage, assertion failures, and links to details.

## 2. Data Model / Contracts

### YAML shape

Visualization config is optional. Omitting it enables the default file-based latest report when the file output provider is enabled.

```yaml
visualization:
  enabled: true
  formats: [html, json, csv]
  latest: true
  include:
    logs: true
    workspaceDiff: true
    toolCalls: true
    mockCalls: true
    judgeDetails: true
```

Fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `enabled` | no | Enables report generation. Defaults to true for file output. |
| `formats` | no | Export formats. Supported first-release values: `html`, `json`, `csv`. |
| `latest` | no | Writes `.harness-evals/output/latest/*`. Defaults to true. |
| `include.logs` | no | Include or link stdout/stderr and parsed logs. Defaults to true. |
| `include.workspaceDiff` | no | Include workspace diff details. Defaults to true. |
| `include.toolCalls` | no | Include parsed tool calls. Defaults to true. |
| `include.mockCalls` | no | Include mock CLI/MCP calls. Defaults to true. |
| `include.judgeDetails` | no | Include judge rubrics, scores, and rationales. Defaults to true. |

### View model

```ts
interface VisualizationConfig {
  enabled: boolean;
  formats: VisualizationFormat[];
  latest: boolean;
  include: VisualizationIncludeConfig;
}

type VisualizationFormat = 'html' | 'json' | 'csv';

interface VisualizationIncludeConfig {
  logs: boolean;
  workspaceDiff: boolean;
  toolCalls: boolean;
  mockCalls: boolean;
  judgeDetails: boolean;
}

interface RunReport {
  runId: string;
  status: 'passed' | 'failed' | 'error' | 'incomplete';
  startedAt: string;
  completedAt?: string;
  summary: RunReportSummary;
  columns: AgentReportColumn[];
  rows: TestCaseReportRow[];
}

interface RunReportSummary {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  score?: number;
  durationMs?: number;
  cost?: CostSummary;
  tokenUsage?: CostRollup;
}

interface AgentReportColumn {
  agentName: string;
  label?: string;
  adapter: string;
  provider?: string;
  model?: string;
}

interface TestCaseReportRow {
  testCaseId: string;
  suite?: string;
  description?: string;
  cells: Record<string, TestCaseAgentReportCell>;
}

interface TestCaseAgentReportCell {
  status: 'passed' | 'failed' | 'error' | 'skipped' | 'incomplete';
  score?: number;
  durationMs?: number;
  cost?: CostSummary;
  tokenUsage?: CostRollup;
  assertionSummary: { total: number; passed: number; failed: number; requiredFailed: number };
  stepSummary: { total: number; passed: number; failed: number; skipped: number; errors: number };
  runDir?: string;
  details: TestCaseAgentDetails;
}

interface TestCaseAgentDetails {
  steps: StepReport[];
  workspaceDiff?: WorkspaceDiff;
  toolCalls?: ToolCallSummary[];
  mockCalls?: MockCallSummary[];
  judgeResults?: JudgeResult[];
  logs?: ReportLogRef[];
  artifacts?: ReportArtifactRef[];
}
```

### Output files

When the file output provider is active, visualization writes:

```text
.harness-evals/output/latest/
  results.html
  results.json
  results.csv

.harness-evals/runs/<run-id>/
  index.html
```

The static HTML report can reference relative artifact files already written by the file provider. It must not require an external service.

### CLI contract

```text
harness-evals view [--run <run-id>] [--latest] [--open] [--port <n>]
harness-evals export [--run <run-id>] --format html|json|csv --output <path>
```

Rules:

1. `view` defaults to the latest report.
2. `--open` opens the generated HTML report in the system browser when available.
3. `--port` serves a local read-only viewer for historical browsing when implemented.
4. `export` regenerates a report from file-provider records or current run records.

## 3. Lifecycle / State Transitions

### Report lifecycle

```text
output records emitted
  -> run finalizes
  -> visualization reads in-memory records or file-provider artifacts
  -> build normalized RunReport view model
  -> render configured formats
  -> write latest and per-run report files
  -> emit visualization.report record
```

### Triage lifecycle

```text
user opens results.html
  -> filter failures/errors/differences
  -> compare agents by row
  -> inspect failed assertions
  -> inspect step details, logs, tool calls, mock calls, judge results, cost, diff
  -> open run artifact directory for raw data
```

Rules:

1. Report generation happens after a run reaches a terminal state.
2. An incomplete run can still produce a partial report when enough records exist.
3. The view model is derived from output records and file artifacts; it does not duplicate runner business logic.
4. HTML rendering uses already-redacted records and artifacts.
5. Missing optional data appears as unavailable, not zero.
6. The report should keep large logs collapsed or linked so the top-level table remains usable.
7. Multiple agents/models are shown side-by-side for the same test case when present in one run.

## 4. Read Path / Write Path

### Read path

1. Read finalized output records from memory at the end of a run.
2. Read file-provider artifacts when rendering historical runs.
3. Read `run.result`, `run.summary`, `step.assertions`, `step.score`, `step.cost`, `step.events`, `mock.call`, `workspace.diff`, and judge records.
4. Read artifact paths and blob refs from provider metadata.

### Write path

1. Write `results.json` from the `RunReport` view model.
2. Write `results.csv` with one row per `(test case, agent)` cell.
3. Write `results.html` as a static report.
4. Write per-run `index.html` under the run artifact directory.
5. Emit `visualization.report` with paths, formats, and render status.

CSV columns should include at least:

```text
runId,testCaseId,suite,agentName,adapter,provider,model,status,score,durationMs,totalAssertions,failedAssertions,requiredFailed,cost,totalTokens,runDir
```

## 5. HTML Report Requirements

The first HTML report should provide:

1. Summary cards for pass/fail/error counts, score, duration, cost, and token usage.
2. A comparison table with test cases as rows and agents/models as columns.
3. Filters for all, failures, passes, errors, skipped, and changed/different agent outcomes.
4. Sort controls for score, duration, cost, and test case id.
5. Cell details with failed assertion reasons, required failure markers, and score buckets.
6. Expandable step details with output, stdout/stderr links, events, tool calls, mock calls, and judge results.
7. Workspace diff summary and file lists.
8. Redaction-safe links to raw artifacts.
9. No external network dependencies for rendering.

## 6. Failure Modes

| Failure mode | Symptom | Detection | Remediation |
| --- | --- | --- | --- |
| Report render fails | Run artifacts exist but no HTML/CSV output | Renderer exception | Keep `run.result` valid, emit degraded visualization metadata, fix renderer |
| Missing file-provider artifacts | Historical `view` cannot render full details | Artifact paths missing | Render summary-only view or regenerate from output records |
| Large logs make HTML unusable | Browser becomes slow | Report size threshold | Link logs instead of embedding them |
| Secret appears in report | Security issue | Redaction boundary failure | Render only redacted records/artifacts and expand redaction tests |
| Multiple providers disagree | Visualization differs from database provider | Provider-specific persistence issue | Treat normalized output records/file provider as the report source |
| Browser open fails | CLI cannot open report | OS open command error | Print the local path instead |

## 7. Trade-Offs Accepted

- Static HTML is the first target because it is shareable and requires no service.
- JSON and CSV exports are generated from the same view model to keep automation and human reports consistent.
- The viewer reads from file-provider artifacts for local history; database-backed history can be added through an output provider query API later.
- Large logs are linked or collapsed rather than fully embedded by default.
- Visualization remains a derived read model so output records stay authoritative.

## 8. Design Decisions

### Accepted decisions

- Result visualization is enabled by default when file output is enabled.
- The latest report is written to `.harness-evals/output/latest/results.html`.
- The latest machine-readable report is written to `.harness-evals/output/latest/results.json`.
- CSV export is supported for spreadsheet workflows.
- `harness-evals view` opens or serves the latest/historical report.
- Reports compare agents/models side-by-side by test case.
- Reports include assertions, scores, costs, tool calls, mock calls, judge results, and workspace diffs when available.

### Open decisions

- Whether the local viewer should be a static file only or include a small read-only HTTP server for historical browsing.
- Whether report theming should be configurable in the first release.
- Whether result visualization should support database-provider history before or after static reports ship.
