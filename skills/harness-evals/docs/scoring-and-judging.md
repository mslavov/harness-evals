# Scoring and judging

Use assertions to decide whether a step passed, and scoring to compare runs that may all technically pass.

## Built-in assertions

Harness-evals evaluates built-in assertions first, then any `llmJudge` assertions.

Built-ins:

- `exitCode`: passes when the step exit code matches `equals` (defaults to `0`).
- `contains`: passes when the final step output contains `value`.
- `notContains`: passes when the final step output does not contain `value`.
- `toolCalled`: checks tool-call events by `name`, with optional `min`, `max`, and `argsContain`.
- `mockCalled`: checks recorded mock calls by `name`, with optional `surface`, `matched`, `min`, `max`, and `argsContain`.
- `noToolErrors`: fails if any tool call event was marked as an error.
- `workspaceDiff`: checks file changes using `changedFiles`, `addedFiles`, `deletedFiles`, `minChanged`, and `maxChanged`.
- `settingsDrivenSetup`: checks that settings-based setup was recorded and that the agent was not launched with `-e` or `--no-extensions`.

All assertions are `required: true` by default.

## Pass/fail semantics

A step passes only when every required assertion passes. Optional assertions still appear in results and still affect score buckets, but they do not fail the step by themselves.

Run status works like this:

- any step `error` => run `error`
- any step `timeout` => run `timeout`
- all steps `passed` => run `passed`
- otherwise => run `failed`

A harness run exits successfully only when every scenario result has `pass: true`.

## `llmJudge`

`llmJudge` is an assertion type with a numeric threshold.

```yaml
assert:
  - id: quality
    type: llmJudge
    threshold: 0.8
    judge:
      rubric: Score factual correctness from 0 to 1.
      inputs: [finalOutput, toolCalls, workspaceDiff]
```

A judge assertion passes when:

- the returned `score` is greater than or equal to `threshold`, and
- the judge did not explicitly return `pass: false`

If the judge returns `pass: false`, the assertion fails even if the numeric score meets the threshold.

Supported judge inputs:

- `finalOutput`
- `stdout`
- `stderr`
- `events`
- `toolCalls`
- `mockCalls`
- `assertions`
- `workspaceDiff`
- `cost`

The default prompt is built from the rubric and the selected inputs, and asks the judge to return JSON only:

```json
{"score":0.0,"pass":true,"reason":"...","metadata":{}}
```

## Judge defaults

You can set shared judge defaults at the top level:

```yaml
judge:
  provider: openai
  model: gpt-4.1
  apiKeyEnv: OPENAI_API_KEY
  temperature: 0
```

Each `llmJudge` may override `provider`, `model`, `apiKeyEnv`, `temperature`, and `promptTemplate`.

A run will fail fast during config loading if a judge assertion is missing `provider`, `model`, or `apiKeyEnv` after applying top-level defaults.

At execution time, the default judge runner also requires the named environment variable to be set. If it is missing, the assertion fails with an error like `Judge credential env ... is not set`.

## Scoring weights

Harness-evals computes a normalized score from weighted buckets:

- `assertionPassRate`
- `judgeScore`
- `latency`
- `cost`
- `tokenUsage`

Default project weights are:

```yaml
scoring:
  assertionPassRate: { weight: 1 }
  judgeScore: { weight: 1 }
  latency: { weight: 0 }
  cost: { weight: 0 }
  tokenUsage: { weight: 0 }
```

So by default:

- non-judge assertion pass rate contributes 50%
- average `llmJudge` score contributes 50%
- latency, cost, and token usage are reported but do not change the score

Only buckets with `sourceCount > 0` and `weight > 0` are included in the weighted average.

## How score buckets are calculated

- `assertionPassRate`: passed non-judge assertions divided by total non-judge assertions
- `judgeScore`: average of all `llmJudge` scores
- `latency`, `cost`, `tokenUsage`: normalized to the `0..1` range using `best`, `worst`, and `target`

Metric defaults are:

- `latency`: minimize, `best: 0`, `worst: 600000`
- `cost`: minimize, `best: 0`, `worst: 1`
- `tokenUsage`: minimize, `best: 0`, `worst: 200000`

You can override metric scoring per project:

```yaml
scoring:
  latency:
    weight: 0.25
    target: minimize
    best: 1000
    worst: 30000
```

## Redaction expectations

Judge inputs, prompts, output records, and persisted artifacts are redacted before they are written.

Harness-evals automatically redacts environment variables whose names look secret-bearing, including names containing words such as `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, or `AUTH`.

That includes relevant agent auth env vars and judge API key env vars. In practice:

- secrets should appear in artifacts as placeholders like `<redacted:OPENAI_API_KEY>`
- a judge prompt should never contain the raw credential value
- step logs and recorded command payloads should be redacted before persistence

If you use custom secret env names, put those names in the env lists that the run already forwards so they are part of the run redaction set.