# LLD — Validation, Scoring, and LLM Judging

> **HLD:** `../HDL.md`
> **Companion LLDs:** `agent-first-install-and-config.md`, `scenario-runner.md`, `adapter-registry-and-contract.md`, `managed-images.md`, `cost-and-artifacts.md`, `output-providers.md`, `mock-mcps-and-clis.md`, `result-visualization.md`
> **Status:** Draft

## How this fits

This LLD defines how test-case-local assertions, judge assertion thresholds, project-level scoring weights, and structured metrics produce pass/fail results and comparable scores while preserving the HLD invariants for explicit scenario lifecycle and deterministic measurement.

## 1. Domain Overview

Validation answers “may the test case continue?” Scoring answers “how good was the result?” A required assertion failure stops later steps in a multi-step test case. Scores are recorded even when a test case fails, as long as enough output records exist to evaluate the scoring buckets.

Assertion criteria live on individual test cases and steps. Global judge config controls LLM-as-judge defaults. Judge calls use `@mariozechner/pi-ai` for provider/model resolution, request execution, and usage/cost capture. Project-level scoring config defines score types, weights, and metric normalization.

The scoring layer combines three sources:

1. **Assertion pass rate:** pass/fail results from non-judge assertions over output, exit code, events, metadata, and workspace diffs.
2. **Judge assertion score:** normalized scores from `llmJudge` assertions. Judge assertions are still assertions and can gate step progression.
3. **Structured metrics:** project-configured metrics such as latency, token usage, and cost.

## 2. Data Model / Contracts

### YAML shape

Global judge config defines LLM-as-judge defaults. Scoring config defines score types and weights in one place:

```yaml
judge:
  provider: openai
  model: gpt-4.1
  apiKeyEnv: OPENAI_API_KEY
  temperature: 0

scoring:
  assertionPassRate:
    weight: 0.5
  judgeScore:
    weight: 0.4
  cost:
    weight: 0.1
    target: minimize
    best: 0
    worst: 1.0
  latency:
    weight: 0
    target: minimize
    best: 0
    worst: 600000
  tokenUsage:
    weight: 0
    target: minimize
    best: 0
    worst: 200000

tests:
  - evals/tests/**/*.yaml
```

A test case file keeps its own assertions and judge rubrics:

```yaml
# evals/tests/checkout-refactor.yaml
id: checkout-refactor
steps:
  - id: implement
    prompt: Implement the checkout refactor.
    assert:
      - id: exit-code
        type: exitCode
        equals: 0
      - id: no-tool-errors
        type: noToolErrors
      - id: mentions-service
        type: contains
        value: CheckoutService
        required: false
      - id: maintainability
        type: llmJudge
        required: true
        threshold: 0.8
        judge:
          rubric: |
            Score maintainability from 0 to 1.
            Prefer minimal, readable changes that preserve behavior.
          inputs:
            - finalOutput
            - workspaceDiff
```

### Assertion contract

```ts
interface BaseAssertionConfig {
  id?: string;
  type: string;
  required?: boolean; // default true
  [key: string]: unknown;
}

interface LlmJudgeAssertionConfig extends BaseAssertionConfig {
  type: 'llmJudge';
  threshold: number; // required, normalized 0..1
  judge: JudgeAssertionDefinition;
}

type AssertionConfig = BaseAssertionConfig | LlmJudgeAssertionConfig;

interface AssertionResult {
  id?: string;
  type: string;
  pass: boolean;
  required: boolean;
  score?: number;
  threshold?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}
```

Required assertions define the validation gate. Non-required assertions are recorded and can contribute to scoring, but do not stop later steps.

### Judge assertion contract

```ts
interface JudgeDefaults {
  provider: string;
  model: string;
  apiKeyEnv: string;
  temperature?: number;
  promptTemplate?: string;
}

interface JudgeAssertionDefinition extends Partial<JudgeDefaults> {
  rubric: string;
  inputs: JudgeInputRef[];
}

type JudgeInputRef =
  | 'finalOutput'
  | 'stdout'
  | 'stderr'
  | 'events'
  | 'toolCalls'
  | 'mockCalls'
  | 'assertions'
  | 'workspaceDiff'
  | 'cost';

interface JudgeResult {
  score: number; // normalized 0..1
  pass?: boolean;
  reason: string;
  metadata?: Record<string, unknown>;
}
```

Judge defaults come from top-level `judge`. A judge assertion can override `provider`, `model`, `apiKeyEnv`, `temperature`, or `promptTemplate` for that assertion only. The assertion must provide its own `rubric`, `inputs`, and `threshold`.

When explicit judge config is used, `provider`, `model`, and `apiKeyEnv` are required as a complete set after top-level defaults are applied. When no explicit provider/model/api key is configured, the runner falls back to the first configured agent whose adapter supports headless completion.

### Judge runtime contract

The explicit judge runtime uses `@mariozechner/pi-ai`:

1. Resolve the configured `provider` and `model` through pi-ai model resolution.
2. Build a pi-ai `Context` from the judge prompt and redacted input references.
3. Call pi-ai completion with `apiKey` read from `apiKeyEnv` and supported generation options such as `temperature`.
4. Parse the assistant text as `JudgeResult`.
5. Record pi-ai response usage and cost in judge metadata.

The adapter-backed judge fallback uses the first configured agent whose adapter exposes `complete(input): Promise<string>`. The adapter receives the full judge prompt as a single string and returns a string containing the same `JudgeResult` JSON shape.

Judge pass semantics:

1. The judge result must include a numeric `score` in the `0..1` range.
2. The assertion passes when `score >= threshold`.
3. If the judge result explicitly includes `pass: false`, the assertion fails even when the threshold is met.
4. Missing or invalid judge scores fail the assertion.

### Project scoring contract

```ts
type ScoreType =
  | 'assertionPassRate'
  | 'judgeScore'
  | 'latency'
  | 'cost'
  | 'tokenUsage';

type ProjectScoringConfig = Partial<{
  assertionPassRate: ScoreTypeConfig;
  judgeScore: ScoreTypeConfig;
  latency: MetricScoreConfig;
  cost: MetricScoreConfig;
  tokenUsage: MetricScoreConfig;
}>;

interface ScoreTypeConfig {
  weight: number;
}

interface MetricScoreConfig extends ScoreTypeConfig {
  target: 'maximize' | 'minimize';
  best: number;
  worst: number;
}

interface ScoreBucketResult {
  type: ScoreType;
  score: number; // normalized 0..1
  weight: number;
  sourceCount: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

interface ScoreSummary {
  score: number;
  maxScore: 1;
  buckets: ScoreBucketResult[];
}
```

Default scoring config:

```yaml
scoring:
  assertionPassRate:
    weight: 1
  judgeScore:
    weight: 1
  latency:
    weight: 0
  cost:
    weight: 0
  tokenUsage:
    weight: 0
```

Rules:

- A score type with no source values is skipped from the weighted denominator.
- A score type with weight `0` is recorded as available metadata but does not affect the final score.
- Unknown `scoring` keys fail config validation.

## 3. Lifecycle / State Transitions

### Step validation lifecycle

```text
step completed
  -> run non-judge assertions
  -> run judge assertions
  -> required assertions pass?
       |-- yes -> aggregate step score -> step passed
       `-- no  -> aggregate available step score -> step failed -> skip later steps
```

### Score aggregation lifecycle

```text
assertion results + metrics
  -> build score buckets
  -> apply project scoring weights
  -> emit step score record
  -> aggregate test-case scenario score
  -> aggregate run summary
```

Rules:

1. Missing `required` on an assertion means `required: true`.
2. A required assertion failure stops later test-case steps.
3. Judge assertions require `threshold` so the numeric judge score always participates in pass/fail.
4. Score weights do not change pass/fail status.
5. Judge inputs are redacted before sending them through pi-ai.
6. Judge prompts and outputs are emitted with enough metadata to reproduce the evaluation.
7. Final comparison summaries show both pass/fail and score so a high score cannot hide a required failure.

## 4. Read Path / Write Path

### Read path

1. Read top-level `judge` config.
2. Read project-level `scoring` config.
3. Read step `assert` definitions from each test case.
4. Merge top-level `judge` defaults with per-assertion judge config.
5. Read normalized step output records, workspace diff, events, mock calls, assertion results, cost summaries, and metric values.
6. Read judge provider credentials from allowlisted env names.

### Write path

1. Emit `step.judge` records for judge requests, responses, parsed scores, and prompt hashes.
2. Emit `step.assertions` after assertions run.
3. Emit `step.score` after score buckets are aggregated.
4. Emit `scenario.scoreSummary` after test-case scenario scoring completes.
5. Include score and pass/fail rollups in `run.result` and `run.summary` output records.

## 5. Failure Modes

| Failure mode | Symptom | Detection | Remediation |
| --- | --- | --- | --- |
| Required assertion fails | Step fails and later steps are skipped | Assertion result | Inspect assertion reason and related output records |
| Unknown assertion type | Config load fails | Assertion registry lookup | Fix assertion type or add assertion implementation |
| Judge assertion omits threshold | Config load fails | `llmJudge` assertion validation | Add a normalized `threshold` value |
| Judge credential missing | Judge assertion fails | Env lookup for `apiKeyEnv` fails | Set the judge API key env var or remove the judge assertion |
| Judge returns invalid JSON | Judge assertion fails with parse error | JSON parse/schema validation | Tighten judge prompt or inspect raw response |
| Judge score missing or outside `0..1` | Judge assertion fails | Judge result validation | Fix judge prompt or provider parsing |
| Unknown score type | Config load fails | `scoring` key validation | Use a supported score type |
| Metric source unavailable | Score bucket is unavailable and omitted from denominator | Metric lookup returns no value | Fix metric config or accept that the bucket is skipped |
| Judge prompt leaks secret | Security issue | Redaction misses sensitive input | Restrict judge inputs and improve redaction boundaries |

## 6. Trade-Offs Accepted

- Assertions remain test-case-local because pass/fail criteria are test-specific.
- LLM judging is an assertion type so judge thresholds can gate test-case progression.
- Project-level scoring config keeps score-type weights in one place.
- Scores are normalized to `0..1` so heterogeneous buckets can be compared and weighted.
- Judge definitions live in test-case assertions because rubrics are evaluation-specific.
- Judge calls use `@mariozechner/pi-ai` so judge providers follow the same provider/model abstraction as the Pi coding agent.
- Judge defaults live in top-level `judge` config because provider/model choices are usually shared.
- Judge inputs are explicit output references, not whole-run dumps, to reduce cost and secret exposure.
- Mock calls can be used as judge inputs when external integration behavior matters.

## 7. Design Decisions

### Accepted decisions

- Step-level `assert` is the validation gate for multi-step test cases.
- Missing `required` means an assertion is required.
- Test-case and step assertions define test-specific criteria.
- `type: llmJudge` defines rubric-based LLM judging as an assertion.
- Explicit `llmJudge` assertions run through `@mariozechner/pi-ai`; assertions without explicit judge config use the first configured adapter that supports headless completion.
- `llmJudge` assertions require `threshold`.
- Project-level `scoring` controls score-type weighting.
- Supported metric score types are `latency`, `cost`, and `tokenUsage`.
- Final summaries include both pass/fail and normalized score.

### Open decisions

- Whether custom metric score types are needed beyond the first supported set.
- Whether judge calls should support multiple samples and average the result.
