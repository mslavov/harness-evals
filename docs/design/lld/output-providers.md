# LLD — Output Providers

> **HLD:** `../HDL.md`
> **Companion LLDs:** `agent-first-install-and-config.md`, `scenario-runner.md`, `adapter-registry-and-contract.md`, `managed-images.md`, `validation-scoring-and-judging.md`, `cost-and-artifacts.md`, `mock-mcps-and-clis.md`, `result-visualization.md`
> **Status:** Draft

## How this fits

This LLD defines the output provider boundary from the HLD. The test-case runner and supporting subsystems emit normalized output records; output providers persist those records. The built-in file output provider is the default when no output provider is configured.

## 1. Domain Overview

Output providers own all persistence for completed and in-progress runs: logs, command metadata, event summaries, assertions, scores, costs, image metadata, workspace diffs, run results, and comparison summaries. A provider can write to the filesystem, a database, object storage, or another durable target.

The runner does not write directly to provider-specific storage. It emits output records to an output dispatcher. The dispatcher fans each record out to every configured output provider. If the user does not configure output providers, the dispatcher enables the built-in file provider and stores the full run on the filesystem.

## 2. Data Model / Contracts

### YAML shape

No output provider configuration is required for the default file output.

```yaml
# omitted output config means:
output:
  providers:
    - type: file
```

A user can configure one or more providers:

```yaml
output:
  providers:
    - type: file
    - type: postgres
      module: ./evals/output/postgres-output.js
      config:
        connectionEnv: HARNESS_EVALS_DATABASE_URL
```

Provider fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | Built-in provider type or custom provider name. |
| `module` | for custom providers | Project-relative path or package specifier exporting the provider. |
| `export` | no | Named export to read from the module. Defaults to `default`, then `createProvider`, then `provider`. |
| `config` | no | Provider-specific config passed through without harness interpretation. |

### Output provider contract

```ts
interface OutputProviderConfig {
  type: string;
  module?: string;
  export?: string;
  config?: Record<string, unknown>;
}

interface OutputProvider {
  type: string;
  initialize(input: OutputProviderInitializeInput): Promise<void>;
  write(record: OutputRecord): Promise<void>;
  writeBlob?(blob: OutputBlob): Promise<OutputBlobRef>;
  finalize(result: OutputFinalizeInput): Promise<void>;
}

type OutputProviderFactory = () => OutputProvider;

interface OutputProviderInitializeInput {
  projectRoot: string;
  runId: string;
  scenarioId?: string; // runtime id, equal to the test case id
  agentName?: string;
  config: Record<string, unknown>;
}

interface OutputRecord {
  runId: string;
  sequence: number;
  type: OutputRecordType;
  timestamp: string;
  scenarioId?: string; // runtime id, equal to the test case id
  agentName?: string;
  stepId?: string;
  payload: unknown;
  redacted: boolean;
}

type OutputRecordType =
  | 'run.started'
  | 'image.resolution'
  | 'mock.config'
  | 'mock.call'
  | 'step.started'
  | 'step.command'
  | 'step.stdout'
  | 'step.stderr'
  | 'step.events'
  | 'step.judge'
  | 'step.assertions'
  | 'step.score'
  | 'step.cost'
  | 'step.completed'
  | 'workspace.diff'
  | 'scenario.scoreSummary'
  | 'scenario.costSummary'
  | 'run.result'
  | 'run.summary'
  | 'visualization.report';

interface OutputBlob {
  runId: string;
  type: string;
  name: string;
  contentType: string;
  bytes: Uint8Array;
  metadata?: Record<string, unknown>;
}

interface OutputBlobRef {
  provider: string;
  uri: string;
  metadata?: Record<string, unknown>;
}

interface OutputFinalizeInput {
  runId: string;
  status: 'passed' | 'failed' | 'error' | 'incomplete';
}
```

### File provider mapping

The built-in file provider maps output records to the filesystem layout:

```text
.harness-evals/runs/<test-case>-<agent>-<timestamp>/
  workspace/
  config/
  image-resolution.json
  mock-config.json
  mock-calls.jsonl
  steps/
    <step-id>/
      stdout.log
      stderr.log
      command.redacted.json
      events-summary.json
      assertions.json
      score.json
      cost.json
      judges/
        <assertion-id>.json
  workspace-diff.json
  score-summary.json
  cost-summary.json
  result.json

.harness-evals/output/latest/results.html
.harness-evals/output/latest/results.json
.harness-evals/output/latest/results.csv
```

Non-file providers receive the same records and choose their own storage layout.

Custom provider modules may export either an `OutputProvider` object or a synchronous `OutputProviderFactory`. Factory exports are called for each `registry.create()` run, so state held in the returned provider is isolated per run. Object exports are shallow-cloned per run; they should be stateless or initialize per-run state on `this` during `initialize`. Module-level variables and closure-captured values are shared across runs, so stateful providers should prefer `createProvider` or another configured factory export.

## 3. Lifecycle / State Transitions

### Provider lifecycle

```text
config loaded
  -> resolve output providers
  -> initialize providers
  -> dispatch run records
  -> finalize providers
```

Rules:

1. If `output.providers` is absent or empty, the built-in file provider is used.
2. Providers are initialized before the test-case runner emits `run.started`.
3. Every output provider receives every output record.
4. Output records are ordered by a monotonically increasing sequence number per run.
5. Output records are redacted before dispatch unless the record type is explicitly safe and contains no sensitive values.
6. Providers must be idempotent for duplicate `(runId, sequence)` records.
7. A provider can store large content directly from `write`, or it can use `writeBlob` and reference the blob from a later record.

### Dispatch lifecycle

```text
subsystem emits output record
  -> redaction
  -> sequence assignment
  -> provider fan-out
  -> provider acknowledgements
```

The dispatcher waits for provider writes before considering a step or run record persisted. Provider failure handling is fail-fast for the default file provider. For additional providers, the run records the provider failure and continues when the file provider has persisted the record.

## 4. Read Path / Write Path

### Read path

1. Read `output.providers` from `harness-evals.yaml`.
2. Load custom output provider modules when `module` is set.
3. Resolve the configured provider export as either an object provider or provider factory.
4. Create an isolated provider instance for each `registry.create()` call.
5. Read provider-specific config and pass it to `initialize`.
6. Read in-memory output records from the runner and subsystems.

### Write path

1. The runner and subsystems emit normalized `OutputRecord` values.
2. The dispatcher redacts, sequences, and fans records out to providers.
3. The file provider writes the default filesystem artifacts.
4. The visualization renderer writes configured derived reports from redacted records and file artifacts.
5. Custom providers persist the same records to their configured durable target.
6. Providers finalize when the run reaches a terminal state.

## 5. Failure Modes

| Failure mode | Symptom | Detection | Remediation |
| --- | --- | --- | --- |
| No output config | File artifacts are written | `output.providers` absent | This is expected default behavior |
| Custom provider import fails | Config load fails | Module import error | Fix provider module path or package installation |
| Provider contract invalid | Config load fails | Missing `initialize`, `write`, or `finalize` | Export a valid output provider |
| File provider write fails | Run fails or is marked incomplete | Filesystem write error | Fix permissions or available disk space |
| Secondary provider write fails | Run continues after file provider persists record; provider failure is recorded | Provider `write` rejects | Inspect provider failure metadata and retry/replay if supported |
| Provider stores unredacted data | Secret exposure risk | Redaction boundary failure or provider bypass | Ensure dispatcher redacts before fan-out and providers do not read raw secrets |
| Duplicate delivery | Provider sees same record more than once | Retry or replay | Use `(runId, sequence)` idempotency |

## 6. Trade-Offs Accepted

- The file provider is the default because it preserves local inspectability and requires no external infrastructure.
- Multiple providers receive the same normalized records so users can combine local artifacts with durable database storage.
- Provider config is pass-through because database/object-store providers have different connection and schema needs.
- The dispatcher redacts before provider fan-out so providers do not need to implement their own secret handling.
- The default file provider is fail-fast because local artifacts are the baseline source of run inspection.

## 7. Design Decisions

### Accepted decisions

- Output providers handle all persisted run output.
- The built-in file output provider is enabled when no output provider is configured.
- Users can configure a list of output providers.
- Each configured provider receives the same normalized output records.
- Custom output providers can be loaded from project-relative modules or package specifiers.
- Custom output provider factories create isolated provider instances per run.
- Output provider config is passed through without harness interpretation.

### Open decisions

- Whether secondary output provider failures should fail the whole run or only mark provider persistence as degraded.
- Whether output records should support replay from the file provider into another provider.
