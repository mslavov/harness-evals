# LLD — Cost Accounting and Output Records

> **HLD:** `../HDL.md`
> **Companion LLDs:** `agent-first-install-and-config.md`, `scenario-runner.md`, `adapter-registry-and-contract.md`, `managed-images.md`, `validation-scoring-and-judging.md`, `output-providers.md`, `mock-mcps-and-clis.md`, `result-visualization.md`
> **Status:** Draft

## How this fits

This LLD defines adapter-reported usage/cost totals and the cost-related output records consumed by output providers. Output providers own persistence for those records.

## 1. Domain Overview

Adapters report usage and cost for each step. Coding agents usually expose session totals themselves; the harness records those totals instead of accepting user-maintained cost tables. The framework normalizes adapter reports, rolls them up by step, test case, runtime scenario, agent, provider, model, and total run, then emits cost output records to the output dispatcher.

This LLD does not define where output is stored. The built-in file output provider stores cost output on the filesystem; other providers can store the same records in a database or another durable target.

## 2. Data Model / Contracts

### Adapter cost report

```ts
interface UsageReport {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  toolCalls?: number;
  requests?: number;
  metadata?: Record<string, unknown>;
}

interface CostReport {
  currency?: string;
  totalCost?: number;
  usage?: UsageReport[];
  byProvider?: Record<string, CostRollup>;
  byModel?: Record<string, CostRollup>;
  metadata?: Record<string, unknown>;
}

interface CostRollup {
  totalCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  requests?: number;
}

interface CostSummary {
  currency?: string;
  totalCost?: number;
  byProvider: Record<string, CostRollup>;
  byModel: Record<string, CostRollup>;
  steps: Record<string, CostReport>;
}
```

Cost report rules:

- The framework does not compute cost from token counts.
- When a coding agent reports only cumulative session totals, the adapter records those totals for the current step and the framework uses the latest cumulative total as the test-case scenario total.

### Event summary integration

```ts
interface AgentEventsSummary {
  finalOutput: string;
  toolCalls: Array<{ name: string; args?: unknown; result?: unknown; isError?: boolean }>;
  errors: string[];
  cost?: CostReport;
}
```

### Cost output records

```ts
type CostOutputRecord =
  | { type: 'step.cost'; stepId: string; payload: CostReport }
  | { type: 'scenario.costSummary'; payload: CostSummary };
```

The output dispatcher sends these records to every configured output provider.

## 3. Lifecycle / State Transitions

### Cost lifecycle

```text
adapter events
  -> adapter cost report
  -> step cost output record
  -> test-case scenario cost summary record
  -> run comparison summary record
```

Rules:

1. Adapters report usage and cost totals; the framework owns normalization and rollup only.
2. Missing token counts do not fail a step; they remain absent in the cost report.
3. Missing cost totals do not fail a step; `totalCost` remains absent.
4. Cost summaries group by provider, model, step, test case, agent, runtime scenario, and total run when those dimensions are available.
5. Judge model usage and cost from `@mariozechner/pi-ai` responses are included in cost reports when available.
6. Mixed currencies are not summed into one `totalCost`; each currency remains separate in metadata or rollups.

## 4. Read Path / Write Path

### Read path

1. Read adapter `cost` values from in-memory event summaries.
2. Read judge usage/cost metadata from `@mariozechner/pi-ai` responses.
3. Read existing cost output records only when building a summary from persisted output.

### Write path

1. Emit `step.cost` after each step's event summary is parsed.
2. Emit `scenario.costSummary` after all runnable steps finish.
3. Include cost rollups in `run.result` and `run.summary` output records.
4. Let output providers persist the records.

## 5. Failure Modes

| Failure mode | Symptom | Detection | Remediation |
| --- | --- | --- | --- |
| Adapter omits cost | Cost summary has unavailable cost | No `cost` in event summary | Add adapter cost extraction or accept missing cost for that adapter |
| Agent reports only cumulative totals | Step-level cost appears cumulative instead of delta | Adapter marks metadata as cumulative | Use latest cumulative total for the test-case scenario summary |
| Mixed currencies | Total cost cannot be summed | Cost reports use different currencies | Keep separate currency rollups and omit single total |
| Partial run after crash | Missing test-case scenario cost summary | Process exits before finalization | Preserve completed step cost records and mark result incomplete when inspected |

## 6. Trade-Offs Accepted

- Usage and cost extraction belong to adapters because event formats and agent accounting differ by CLI/provider.
- Coding agents and adapters are responsible for reporting totals.
- Missing cost data is represented explicitly instead of failing otherwise valid evaluations.
- Provider/model rollups are retained because per-model comparison is a primary reporting dimension.
- Cost output is emitted as normalized records so file and non-file providers can persist the same information.

## 7. Design Decisions

### Accepted decisions

- Adapters provide session cost totals when the coding agent exposes them.
- The framework uses adapter-reported cost totals as-is.
- Cost summaries include per-step, per-provider, per-model, per-agent, and total rollups when reported dimensions are available.
- Judge usage and cost from `@mariozechner/pi-ai` responses are included in cost rollups when available.
- Cost data is emitted through output records and persisted by output providers.

### Open decisions

- Whether output summaries include historical baseline comparison or only current-run scores and costs.
