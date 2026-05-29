# Verifiers

A **verifier** is an optional command that runs **once, after all agent steps finish**, to decide whether the run actually succeeded. Where assertions inspect what the agent said and did during a step, a verifier inspects the **end state** of the workspace by running real code against it — most often a test suite or a grading script.

Use this page to decide whether you need a verifier, and how to wire one up.

## Why verifiers exist

Step assertions (`exitCode`, `contains`, `workspaceDiff`, `toolCalled`, `llmJudge`, …) are great for checking *behavior*: did the agent run the right tool, edit the right files, print the expected string. But many tasks can only be judged by **executing the result**:

- "Fix the failing test" — the only honest check is running the test suite afterward.
- "Implement this feature" — correctness is defined by a hidden test file the agent must not see.
- "Refactor without breaking anything" — you need the full build + tests to pass on the final tree.

A verifier gives you a single, deterministic, code-based pass/fail (and an optional numeric reward) computed on the workspace the agent left behind. It is the difference between "the agent claimed it fixed the bug" and "the bug is fixed."

## Verifier vs. assertions — which to use

| Question | Use |
| --- | --- |
| Did the agent call a tool / print a string / touch a file? | step `assert` |
| Is the resulting code correct when executed? | `verifier` |
| Should grading material stay hidden from the agent? | `verifier` (+ `hiddenPatch` or `assetsDir`) |
| Is quality subjective (tone, plan quality)? | `llmJudge` assertion |
| Do you need a 0/1 score for pass@k? | `verifier` with a binary reward |

They compose. A typical case uses step assertions to gate intermediate steps (e.g. a plan step must mention "refactor") and a verifier to decide final correctness. When a verifier is configured, **the run passes only if every required step assertion passes and the verifier passes.**

## When to use one

Reach for a verifier when:

- success is defined by tests, a build, a linter, or any executable check;
- you want grading logic that the agent cannot read or game (hidden tests);
- you are running a benchmark where each task ships its own grading script;
- you want pass@k over repeated attempts (`attempts` + a binary `0`/`1` reward).

You do **not** need a verifier when behavioral assertions already prove success, or for one-off exploratory prompts.

## Minimal verifier

```yaml
id: fix-failing-test
prompt: The unit tests are failing. Find the bug and fix it.
verifier:
  command: bun
  args: [test]
  network:
    mode: none
```

If `bun test` exits non-zero the verifier fails the run; if it exits `0` the run passes. No reward file is needed for a simple exit-code check — but rewards give you finer signal (see below).

## How it runs

1. All agent steps run first, in order, sharing one workspace.
2. After the last step (or after a required assertion stops the run), the verifier runs **once** in a fresh `docker run` against the **same Docker image** as the agent.
3. The workspace the agent edited is mounted in, so the verifier sees the agent's changes.
4. The verifier's exit code, captured reward, and logs are written under the run directory and folded into run pass/fail and scoring.

Because it is a separate container from the agent steps, the verifier only sees what persists on the mounted workspace — not in-memory state from the agent run.

### Network policy

Verifiers are network-restricted by default. When `verifier.network` is omitted, the verifier runs with `--network none`. This keeps grading deterministic and prevents hidden tests from reaching the internet.

```yaml
verifier:
  command: bun
  args: [test]
  network:
    mode: none        # none (default) | default | allowlist
```

- `none`: `--network none`. Prefer this for hidden tests and deterministic checks.
- `default`: leaves Docker networking at its default.
- `allowlist`: bridge networking, with `HARNESS_EVALS_NETWORK_ALLOWLIST` exposed in the container for verifier tooling or a proxy to honor.

## Rewards

A verifier can emit a numeric **reward** in addition to its exit code. Write it to a workspace-relative file and point `rewardFile` at it:

```yaml
verifier:
  command: bash
  args: [grade.sh]
  rewardFile: reward.txt
  rewardFormat: text       # auto | text | json
```

- `text`: the file is a single number, parsed as `{ reward: <number> }`.
- `json`: the file is a JSON object whose values are all numeric (a reward map).
- `auto`: inferred from the file.

Pass/fail from a reward: a configured reward **passes when the primary reward is positive** (a reward of `0` fails). The primary reward is the `reward` key when present, the sole value for a single-entry map, or the average across a multi-key map. The reward also feeds the `verifierReward` scoring bucket (clamped to `0..1`).

### pass@k

Set `attempts` to repeat a case and report pass@k:

```yaml
attempts: 5
verifier:
  command: bun
  args: [test]
  rewardFile: reward.txt
```

Pass@k is computed only when repeated attempts produce **binary** rewards (`0` or `1`). Missing verifier results count as non-successes; non-binary reward maps make the group ineligible.

## Hidden grading material

Often the grading logic must stay out of the agent's reach so the agent solves the task instead of editing the test. There are two mechanisms.

### `hiddenPatch` — patch the workspace before grading

```yaml
verifier:
  command: bun
  args: [test]
  hiddenPatch: evals/hidden/my-case.patch
  captureModelPatch: true
```

After the agent finishes, harness-evals captures `model.patch` (the agent's changes) **first**, then applies `hiddenPatch` to the copied run workspace before the verifier runs. The hidden test content therefore never appears in `model.patch`, and the patch is applied to the run copy — never your source repo.

### `assetsDir` — mount grading files verifier-only

```yaml
verifier:
  command: bash
  args: [/tests/run.sh]
  assetsDir: evals/hidden/my-case/tests   # project-relative host dir
  assetsTarget: /tests                     # default /tests
```

`assetsDir` mounts a host directory **read-only into the verifier container only** — never into agent steps. Put a `test.sh`, hidden test files, fixtures, or a grading harness there and the verifier command can read them while the agent stays blind to them.

**`hiddenPatch` vs `assetsDir`:** use `hiddenPatch` when grading is a patch that must merge into the existing tree (e.g. adding hidden test cases to an existing test file). Use `assetsDir` when grading is a self-contained set of files the verifier runs directly (a script + test data), or when the repo-under-test lives inside the image rather than in a host-copied workspace.

## Full field reference

```yaml
verifier:
  command: bun                 # required: command run in the agent's Docker image
  args: [test, --runInBand]    # optional command arguments
  cwd: /workspace              # optional; relative values resolve under the workspace container path
  env: [CI]                    # optional explicit env vars to forward to the verifier
  timeoutMs: 120000            # optional verifier timeout
  rewardFile: reward.txt       # optional workspace-relative reward file
  rewardFormat: auto           # auto | text | json
  hiddenPatch: evals/hidden/x.patch   # optional patch applied before grading
  captureModelPatch: true      # write model.patch before the hidden patch is applied
  assetsDir: evals/hidden/x/tests     # optional verifier-only read-only mount
  assetsTarget: /tests         # mount path for assetsDir (default /tests)
  network:
    mode: none                 # none (default) | default | allowlist
```

## What lands in artifacts

When a verifier is configured, the run directory gains:

- `verifier/result.json` — status, exit code, captured reward, timing
- `verifier/reward.json` — the parsed reward
- verifier stdout/stderr logs
- `model.patch` and `hidden-patch.json` when hidden-test patching is configured

Inspect these when a verifier scores `0` to see whether the agent's patch was wrong or the verifier itself errored.

## Run status with a verifier

From the run's perspective:

- verifier `error` → run `error`
- verifier `timeout` → run `timeout`
- verifier failed reward or non-zero exit → run `failed`
- all steps `passed` **and** verifier passed → run `passed`

## Related

- [Writing evals](./writing-evals.md) — the verifier block in context of a full test case
- [Scoring and judging](./scoring-and-judging.md) — how `verifierReward` is bucketed and scored
- [Docker workspaces and images](./docker-workspaces-and-images.md) — verifier network policy and seeding the workspace from an image
- [Concepts](./concepts.md) — where the verifier sits in the run lifecycle
