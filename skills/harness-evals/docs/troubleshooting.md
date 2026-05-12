# Troubleshooting

## Could not find `harness-evals.yaml`

Symptom:

- `Could not find harness-evals.yaml from ...`

What to check:

- run the CLI from the project that owns the eval config, or pass `--config path/to/harness-evals.yaml`
- confirm the file is named exactly `harness-evals.yaml`

## Path escaping and traversal errors

Common messages:

- `Path escapes project root (...)`
- `Test file glob must not contain path traversal`

Harness-evals rejects test globs, fixtures, mock fixture references, and other project paths that resolve outside the project root.

Fixes:

- keep `tests:` globs project-relative, for example `evals/tests/**/*.yaml`
- keep `workspace.fixture` inside the repo
- keep mock fixture references inside `evals/mocks/...`
- remove `../...` segments from config values

## Docker image setup problems

### Ready image probe failures

Symptom:

- `Ready Docker image <image> failed probe ...`

Meaning:

- you set `docker.image` or passed `--image`, and the selected adapter(s) could not find required tools in that image

Fixes:

- use an image that already contains the adapter's required runtime/tools
- or remove `docker.image` / `--image` so harness-evals builds a managed image

### Managed image build or probe failures

Common messages:

- `Managed Docker image build failed ...`
- `Managed Docker image <image> failed probe ... after build`

Fixes:

- inspect `image-resolution.json` in the run directory
- check the adapter install recipe or project dependencies the adapter expects
- confirm Docker is installed and usable from your shell

## Unsupported adapters for MCP mocks

Symptom:

- `MCP mocks are declared for <case>, but adapter <name> does not support applyMcpMocks`

Meaning:

- the test case declares `mocks.mcp`, but the selected adapter does not implement MCP mock wrapping

Fixes:

- switch to an adapter that supports MCP mocks
- or replace the MCP mock with CLI mocks or a different test design

## Missing reports

### `view` says report not found

What `view` expects:

- latest report: `output/latest/results.html`
- run report: `<artifactRoot>/<run-id>/index.html`

Fixes:

- make sure visualization is enabled
- make sure `html` is included in `visualization.formats`
- rerun the eval if artifacts were deleted
- use the correct run id from the run directory name

### `export` cannot produce a format

Common messages:

- `Visualization is disabled`
- `Visualization format is not enabled: csv`
- `Report not found: ...`
- `Run result not found: ...`

Fixes:

- enable visualization in config
- add the format you want to `visualization.formats`
- for latest exports, make sure a run has already produced `output/latest/results.<format>`
- for run-specific exports, make sure the run directory still contains `result.json`

## Mock failures

### Unmatched strict mocks

Symptom:

- a step fails with an error assertion mentioning an unmatched mock call

Meaning:

- strict mocks are on, and the external CLI or MCP call did not match any fixture rule

Fixes:

- inspect `mock-calls.jsonl` and any step-level `mock-calls.jsonl`
- check the fixture rule ids, matching fields, and wildcard patterns
- relax or disable strictness only if the test really should allow unmatched calls

### Expected mock call not recorded

What to check:

- the fixture is declared at the test-case or step level you intended
- step-level mocks override test-case mocks for the same command/server
- `mockCalled` assertions use the right `name` and optional `surface`
- call recording is enabled in mocks defaults if you expect artifacts

## Judge configuration and credentials

### Judge settings missing

Common messages:

- `llmJudge requires judge.provider or top-level judge.provider`
- `llmJudge requires judge.model or top-level judge.model`
- `llmJudge requires judge.apiKeyEnv or top-level judge.apiKeyEnv`
- config-load errors saying a judge assertion requires top-level defaults

Fixes:

- define `provider`, `model`, and `apiKeyEnv` on each `llmJudge`, or
- set them once in top-level `judge:` defaults

### Judge credential env is not set

Symptom:

- `Judge credential env <NAME> is not set`

Fixes:

- export the named environment variable before running harness-evals
- make sure the `apiKeyEnv` name matches the variable you actually set

### Judge runtime dependency cannot load

Symptom:

- `Failed to load @mariozechner/pi-ai for llmJudge: ...`

Fixes:

- reinstall project dependencies
- make sure the runtime environment used to launch harness-evals has access to installed packages

## Unknown or unsupported adapters

Common messages:

- `Unknown adapter: <name>`
- output or adapter import errors for project-defined modules

Fixes:

- confirm the agent's `adapter` name matches a built-in adapter or a declared project adapter
- if using a project adapter, verify `adapters.<name>.module` resolves from the project root
- confirm the exported adapter object implements `prepareStep` and `parseEvents`

## When to inspect run artifacts first

If a run failed and the top-level error is too short, start here:

- `records.jsonl` for the full event stream
- `result.json` for the final scenario result
- `steps/<step-id>/stdout.log` and `stderr.log`
- `steps/<step-id>/assertions.json`
- `image-resolution.json` for Docker/image failures
- `mock-calls.jsonl` for mock matching problems
- `steps/<step-id>/judges/*.json` for judge prompt/result details