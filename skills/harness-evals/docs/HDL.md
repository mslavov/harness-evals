# Harness evals HLD

> **Status:** Draft
> **Date:** 2026-05-03
> **Goal:** Define a Docker-isolated coding-agent evaluation harness with agent-first onboarding, extensible adapters, managed local runtime images, multi-step test cases, deterministic MCP/CLI mocks, cost reporting, scoring, pluggable output providers, and result visualization.

## 1. Executive Summary

Harness evals runs real coding-agent CLIs against copied workspaces in Docker and emits command metadata, logs, parsed events, workspace diffs, mock calls, assertions, scores, costs, and summaries for each test-case/agent run. Output providers persist those records. The default output provider is file-based and stores the full run on the filesystem; additional providers can persist the same output stream to a database or another durable store. The source workspace is never mounted read-write; each run operates on an isolated copy plus a per-run config mount.

An authored test case can be a one-shot prompt or a multi-step workflow. Test cases are YAML files discovered from `evals/tests/**/*.yaml` by default; `harness-evals.yaml` can override the selected test files through a simple `tests` list of glob patterns. Test cases can declare MCP and CLI mocks under `evals/mocks/` so external integrations remain deterministic while agents still call realistic tools. In multi-step test cases, the framework sends a prompt, lets the agent act, validates the result, and only advances to the next prompt when required validations pass. Assertions stay with individual test cases and steps. Project-level scoring config controls how assertion outcomes, judge assertion scores, and structured metrics are weighted so runs can be compared across agents, models, prompts, and framework changes.

The design makes adapter registration, test glob selection, mock defaults, output providers, visualization settings, judge defaults, and scoring part of `harness-evals.yaml`, supports project-defined adapter modules, and adds harness-managed local image builds. Each selected adapter can contribute an installation recipe; the harness builds and caches a local image containing the selected providers unless the consumer supplies a ready image. The primary setup path is an installable agent skill that ships with the design docs and guides the user's coding agent through installation, project discovery, configuration, test-case creation, mock fixture setup, and first-run validation.

### Key invariants

1. **Agent-first setup:** The default onboarding path is a distributable `harness-evals` skill installed into the user's coding agent with the Skills CLI.
2. **Workspace isolation:** The runner mounts only the copied workspace read-write; the source project is never mutated by an eval run.
3. **Explicit scenario lifecycle:** Test-case steps, validation gates, stop conditions, and adapter continuation metadata are represented in test files, config, and artifacts.
4. **Adapter boundary:** Agent-specific command construction, multi-step continuation, config preparation, installation recipe, event parsing, usage, and cost reporting live behind named adapters.
5. **Config-declared extensibility:** `harness-evals.yaml` is the source of truth for named agents, project-defined adapter registrations, output providers, visualization settings, mock defaults, and test glob selection overrides.
6. **Local image ownership:** The harness may build and cache local runtime images, but it does not publish images; a consumer-supplied ready image bypasses managed builds.
7. **Deterministic external surfaces:** Test cases can replace external MCP servers and CLIs with declared mocks that record every call.
8. **Output provider boundary:** All persisted run output flows through configured output providers; the file output provider is used when no provider is configured.
9. **Result visualization:** File output includes shareable reports and machine-readable exports for comparing test cases, agents, models, scores, costs, and failures.
10. **Deterministic measurement:** Every run emits enough redacted metadata to reconstruct adapter behavior, image selection, commands, config, events, mock calls, assertions, judge outputs, scores, costs, and workspace changes.

## 2. Architecture at a Glance

```text
Skills CLI installs harness-evals skill
  -> user activates /harness-evals in coding agent
  -> agent reads bundled docs and configures project
  -> harness-evals.yaml
  -> config loader
  -> test-case loader (default evals/tests/**/*.yaml; harness-evals.yaml tests glob override)
  -> adapter registry (built-ins + YAML-declared modules)
  -> test-case/agent matrix builder
  -> mock resolver (test-case + step MCP/CLI mocks)
  -> image resolver
       |-- ready image supplied? use it
       `-- otherwise build/reuse cached local image from selected adapter install recipes
  -> test-case runner
       -> stage mocks and config
       -> step prompt
       -> adapter prepareStep()
       -> Docker copied workspace run
       -> adapter parseEvents() + usage/cost report
       -> mock call collection
       -> assertions, including judge assertions
       -> validation gate
       `-- next step or final result
  -> output dispatcher
       |-- file output provider (default)
       `-- configured output providers
  -> result visualization
       |-- static HTML report
       |-- JSON export
       `-- CSV export
```

The adapter registry resolves every `agents.<name>.adapter` before matrix execution. The mock resolver runs after test cases are loaded and before each step executes so it can stage MCP/CLI wrappers under the run config. The image resolver runs after the test-case/agent matrix is known so it can build or reuse the smallest compatible local image for the selected adapters/providers.

## 3. Core Concepts

- **Harness evals skill:** An installable agent skill that bundles these docs and guides a coding agent through framework installation, project discovery, configuration, extension points, test-case creation, and first-run validation.
- **Test case:** The authored eval unit, usually one YAML file under `evals/tests/`. A test case can define a one-shot prompt or a multi-step workflow with workspace setup, agent selection, prompts, assertion gates, and stop conditions.
- **Scenario:** The runtime lifecycle for one test case executed with one selected agent. Runtime scenario identifiers use the test case id.
- **Step:** One interaction in a test case. A step sends a prompt, receives agent output/events, validates the workspace/output, records cost, and contributes to scoring.
- **Adapter continuation:** Opaque adapter metadata passed between steps when an agent needs provider-specific state for multi-step execution.
- **Validation gate:** Required assertions that decide whether a multi-step test case advances, stops as failed, or records a non-blocking finding.
- **Score:** A numeric rollup produced from assertion pass rates, judge assertion scores, and project-configured structured metrics.
- **Agent:** A named YAML entry that selects an adapter and provides model, provider, env, command, config, timeout, and parser settings.
- **Adapter:** A named runtime integration that prepares commands/config, manages multi-step continuation, declares image installation requirements, parses events, and reports usage/cost.
- **Adapter registry:** The resolved set of built-in and YAML-declared adapter modules available to a run.
- **Runtime image:** The Docker image used for execution. It is either supplied by the consumer or built locally by the harness from adapter installation recipes.
- **Mock fixture:** YAML test data that defines deterministic responses for external CLI commands or MCP tool calls.
- **CLI mock:** A PATH-shadowing wrapper executable that matches command invocations and returns configured stdout/stderr/exit codes.
- **MCP mock:** A stdio JSON-RPC wrapper that intercepts selected MCP `tools/call` requests, optionally passing other traffic through to the real server.
- **Output record:** A normalized event or payload produced by the runner, adapter, score aggregator, mock resolver, image resolver, assertion engine, or visualization layer.
- **Output provider:** A persistence target that receives all output records. The built-in file provider writes the filesystem artifact layout; other providers can store records in durable systems such as databases.
- **Result visualization:** A derived, human-readable view over output records and file artifacts, including HTML, JSON, and CSV reports.
- **Run artifact directory:** The file output provider's per-run directory containing the copied workspace, temporary config, logs, mock records, event summaries, workspace diffs, cost reports, score reports, command metadata, and result JSON.

## 4. Runtime Architecture

The CLI loads `harness-evals.yaml`, resolves built-in and project-defined adapters, loads test cases from configured `tests` references, expands the test-case/agent matrix, resolves test-case mock declarations, and resolves a runtime image for the selected agents. When `tests` is omitted, the loader uses `evals/tests/**/*.yaml` by default. If a ready image is explicitly supplied, the harness uses it directly and validates required commands during run preparation. Otherwise, selected adapters provide install recipes and probes; the harness computes a cache key from the base image plus install recipes, builds a local image when the key is missing or incomplete, and reuses it for compatible later runs.

For each test-case/agent entry, the runner creates an output context, copies the source workspace or fixture once for the run, snapshots it, and executes each step in order. Before each step, the mock resolver stages CLI wrappers and MCP wrapper plans for any test-case or step mocks, and adapters apply MCP wrappers to their agent-specific config. The adapter prepares each step and receives any prior continuation metadata, Docker executes against the copied workspace with allowlisted env and config mounts, the adapter parses events and reports usage/cost, the harness collects mock call logs, assertions evaluate the step, and the validation gate decides whether to continue. After the final step or failure gate, the runner snapshots and diffs the workspace, aggregates assertions, scores, and costs, emits output records to the configured output providers, renders configured result visualizations, and removes cleanup-only secret copies.

## 5. Execution Flows

### Agent-first setup run

1. User installs the `harness-evals` skill with the Skills CLI for one or more coding agents.
2. User activates the skill with `/harness-evals`.
3. The active agent reads the bundled docs index from the skill.
4. The agent inspects the project and asks for missing setup inputs.
5. The agent installs the framework package, creates or updates `harness-evals.yaml`, adds selected agents, creates starter test cases under `evals/tests/`, creates mock fixtures under `evals/mocks/` when needed, configures judge/scoring/output/visualization defaults, and runs validation.

### Managed-image test run

1. Load config, test cases, agents, and adapter declarations.
2. Resolve selected adapters for the test-case/agent matrix.
3. Collect adapter install recipes and required command probes.
4. Reuse a cached local image when its key covers the selected adapters; otherwise build one from the internal managed-image base.
5. Execute each test-case/agent pair in Docker against a copied workspace.
6. Aggregate step events, validation results, scores, and costs, then dispatch output records to all configured output providers.

### Ready-image test run

1. Consumer sets a ready image in config or via CLI override.
2. Harness skips managed image build and cache lookup.
3. Adapter run preparation verifies the required CLI/config contract as early as practical.
4. Missing tools fail with an actionable message instead of triggering image rebuild.

### Mocked test run

1. Load test-case and step mock declarations.
2. Resolve mock fixture files from `evals/mocks/cli` and `evals/mocks/mcp`.
3. Stage CLI wrappers and MCP wrapper plans under the run config directory.
4. The adapter rewrites selected MCP server config entries to use the harness wrapper and leaves unmocked servers unchanged.
5. Docker runs with the mock PATH prefix, config mounts, and call-log env vars.
6. The harness collects mock call logs and emits `mock.config` and `mock.call` output records for assertions, scoring, and visualization.

### Multi-step test-case run

1. Runner starts the test-case workspace and asks the adapter to prepare the first step.
2. Runner sends the first step prompt and records events, workspace changes, usage, and cost.
3. Required validations pass before the next step prompt is sent.
4. The adapter returns opaque continuation metadata when it needs state for the next step.
5. The test-case scenario ends when all steps complete, a required validation fails, a stop condition triggers, or the timeout is reached.

### Scoring run

1. Test-case step assertions evaluate exit code, output, tool calls, workspace diff, metadata, and step-specific expectations.
2. LLM-as-judge assertions evaluate configured rubrics using redacted output records and must declare a score threshold for pass/fail.
3. Structured score buckets normalize project-configured metrics such as assertion pass rate, latency, token usage, and cost.
4. Project-level scoring weights aggregate step scores into test-case scores and run summaries.

### Custom adapter run

1. `harness-evals.yaml` registers a local or package adapter module under a unique name.
2. Agents reference that adapter by name.
3. The registry imports the adapter, validates the adapter contract, and includes its installation recipe in image resolution.
4. The runner treats the custom adapter the same as a built-in adapter for preparation, multi-step continuation, parsing, cost reporting, metadata, mock integration, and cleanup.

### Visualization run

1. Output providers persist normalized run records and file artifacts.
2. The visualization layer builds a derived report model from run records.
3. The file visualization writes `results.html`, `results.json`, and `results.csv` under `.harness-evals/output/latest/`.
4. `harness-evals view` opens or serves the latest or selected historical report.

## 6. Per-Concern Sections

### Agent-first installation and configuration

The framework ships a `harness-evals` skill installable through the Skills CLI. The skill owns `docs/HDL.md` and `docs/lld/*.md` as source docs, exposes a docs index in `SKILL.md`, and uses those docs as the source of truth for agent-led setup.

When activated, the skill instructs the coding agent to collect project context, detect or ask for the active agent, ask which additional agents should be configured, gather desired test cases, install the framework package, create minimal harness config, and verify the first run.

### Test case and step orchestration

Test cases are ordered step graphs by default. A one-shot test case is normalized into a single step. Test case files are discovered from `evals/tests/**/*.yaml` unless `harness-evals.yaml` overrides `tests` with glob patterns. The first version can use linear steps; branching can be represented later through explicit stop conditions and named transitions. Each step declares its prompt, timeout overrides, required validations, optional non-blocking checks, and any judge assertions that are specific to that test case.

For multi-step runs, the runner passes opaque continuation metadata between steps. Each adapter decides whether that means native session continuation, transcript replay, CLI-specific context, or no extra state beyond the shared workspace.

### Adapter extensibility

Built-in adapters remain available by default. Project-defined adapters are declared in the main YAML file and loaded dynamically before matrix construction. A project-defined adapter with the same name as a built-in adapter overrides the built-in adapter automatically.

Adapters own agent-specific behavior: command arguments, working directory, env names, config mounts, parser selection, event normalization, multi-step continuation semantics, usage/cost extraction, and optional image installation requirements. Custom adapter modules and install recipes are trusted project-controlled code.

### Managed image build and caching

Managed images are local build artifacts. The cache key includes the base image, selected adapter names, adapter installation recipes, and any adapter-declared version or probe metadata. Adding a provider/adapter whose install recipe is not represented by the cached image produces a different key or fails a probe, causing a rebuild.

Ready images are an explicit escape hatch. When a consumer supplies one, the harness does not build or rebuild; adapter probes only validate that the image satisfies the declared agent contract.

### MCP and CLI mocks

Test cases can declare CLI and MCP mocks. CLI mocks are executable wrappers placed ahead of real commands on `PATH`. MCP mocks are stdio JSON-RPC wrappers that intercept selected `tools/call` requests and can pass through other requests to the real server. Mock fixtures are YAML files under `evals/mocks/cli` and `evals/mocks/mcp` by default.

Mocks are staged under the run config directory and mounted into Docker. Mock wrappers record calls as output records so assertions can verify tool usage, command arguments, MCP health, and external side effects without using live external services. Adapter support is required for MCP mocks because adapters own agent-specific MCP config formats.

### Cost and usage accounting

Adapters report usage and cost in a normalized structure that supports per-step, per-model, per-provider, per-agent, and total rollups. Coding agents usually expose session totals themselves; adapters normalize those totals for the framework.

The framework uses adapter-reported totals as-is and does not compute cost from token counts. Missing cost data is recorded explicitly instead of failing otherwise valid evaluations.

### Validation and scoring

Assertions remain the hard pass/fail contract for required behavior. A required assertion failure blocks later steps in a gated multi-step test case. Non-required assertions can contribute findings and scores without stopping the test case.

LLM judging is modeled as an assertion type. Judge calls use `@mariozechner/pi-ai` for provider/model resolution, request execution, and usage/cost capture. A judge assertion returns a normalized score and passes only when its score meets the assertion threshold. Top-level judge config defines LLM-as-judge defaults. Scoring is a separate rollup layer over assertion outcomes, judge assertion scores, and project-configured metrics. Project scoring config defines score types and weights; individual test cases keep their own assertion criteria. Final summaries include both pass/fail status and comparable scores.

### Isolation, secrets, and config

The workspace copy is the only read-write project mount. Run config is written under the artifact directory and mounted at `docker.configRoot`. Adapters may copy required secret/config files into the run config for the duration of the run, and those cleanup paths are removed from artifacts afterward. Install recipes and scoring prompts must not bake or emit per-user secrets.

### Output providers, artifacts, and observability

All output records are dispatched to the configured output providers. If no output provider is configured, the file output provider is enabled automatically.

The file output provider writes:

```text
workspace/
config/
mock-config.json
mock-calls.jsonl
steps/<step-id>/stdout.log
steps/<step-id>/stderr.log
steps/<step-id>/command.redacted.json
steps/<step-id>/events-summary.json
steps/<step-id>/assertions.json
steps/<step-id>/score.json
steps/<step-id>/cost.json
steps/<step-id>/judges/<assertion-id>.json
workspace-diff.json
score-summary.json
cost-summary.json
image-resolution.json
result.json
index.html
```

The file output provider also writes the latest machine-readable summary under `.harness-evals/output/latest/results.json`. Non-file providers receive the same normalized output records and decide how to store them. Image resolution adds redacted metadata identifying whether the run used a ready image or managed image, the image tag/digest when available, and the adapter install manifest key.

### Result visualization

The visualization layer derives human-readable reports from normalized output records and file artifacts. The default file visualization writes `.harness-evals/output/latest/results.html`, `.harness-evals/output/latest/results.json`, and `.harness-evals/output/latest/results.csv`. Reports compare agents and models side-by-side by test case and include pass/fail status, assertion failures, scores, cost, token usage, duration, tool calls, mock calls, judge results, and workspace diffs when available.

Visualization is a read model, not the source of truth. Output records and provider artifacts remain authoritative. `harness-evals view` opens or serves the latest or selected historical report.

## Related LLDs

- [`lld/agent-first-install-and-config.md`](lld/agent-first-install-and-config.md) — skill-based installation, project discovery, and first-run configuration.
- [`lld/scenario-runner.md`](lld/scenario-runner.md) — test-case and step lifecycle.
- [`lld/adapter-registry-and-contract.md`](lld/adapter-registry-and-contract.md) — adapter loading and contract.
- [`lld/managed-images.md`](lld/managed-images.md) — ready image and managed image resolution.
- [`lld/validation-scoring-and-judging.md`](lld/validation-scoring-and-judging.md) — assertions, scoring, and LLM judging.
- [`lld/cost-and-artifacts.md`](lld/cost-and-artifacts.md) — adapter-reported cost totals and output records.
- [`lld/output-providers.md`](lld/output-providers.md) — pluggable output persistence and default file output.
- [`lld/mock-mcps-and-clis.md`](lld/mock-mcps-and-clis.md) — deterministic mocks for MCP servers and CLI tools.
- [`lld/result-visualization.md`](lld/result-visualization.md) — static reports, JSON/CSV exports, and local result viewing.

## Decision Log

### Accepted decisions

- The harness manages local image builds and caching when no ready image is supplied.
- The harness does not publish provider images.
- Provider/agent installation commands belong to adapters.
- Adding selected providers/adapters not covered by a cached managed image invalidates the cache or triggers rebuild.
- Consumer-provided ready images bypass managed build/rebuild logic.
- `docker.image` represents a consumer-provided ready image; managed-image base selection and tag prefix are internal harness details.
- Dynamic adapter loading requires a registry boundary, name-resolution rules, and contract validation.
- Custom adapter modules and install recipes are trusted project-controlled code.
- `harness-evals.yaml` contains an `adapters` map; agents reference adapters by name.
- Custom adapters can load from project-relative modules or package specifiers.
- Project-defined adapters override built-ins by name.
- Adapter-specific agent options live under `agents.<name>.config` and are passed through to the adapter.
- Test cases support one-shot prompts and gated multi-step workflows.
- By default, test cases are discovered from `evals/tests/**/*.yaml`; `harness-evals.yaml` can override test selection through `tests` glob patterns.
- Test cases can declare CLI and MCP mocks from `evals/mocks/`.
- CLI mocks use PATH shadowing; MCP mocks use adapter-applied stdio JSON-RPC wrappers.
- Adapters report usage and cost for per-step, per-model, and total rollups.
- The framework uses adapter-reported cost totals as-is.
- Scoring combines assertion pass rates, judge assertion scores, and project-configured structured metrics.
- Assertions are defined on individual test cases and steps.
- `type: llmJudge` is an assertion type with a required score threshold.
- LLM-as-judge requests use `@mariozechner/pi-ai`.
- Top-level judge config defines LLM-as-judge defaults.
- Project-level scoring config defines score types and weights.
- Output persistence is handled by output providers.
- If no output provider is configured, the built-in file output provider stores all output on the filesystem.
- Multiple output providers can be configured and receive the same normalized output records.
- Result visualization writes static HTML plus JSON/CSV exports from normalized output records.
- `harness-evals view` opens or serves latest and historical reports.
- The primary onboarding path is an installable `harness-evals` skill distributed with the design docs.

### Open decisions

- Whether first-release multi-step test cases support only linear step order or also named branches.
- Whether MCP mock wrappers support HTTP-based MCP transports in the first release or stdio only.
- Whether result visualization theming is configurable in the first release.

## Success Criteria

- [x] The target design includes an agent-first skill-based onboarding path.
- [x] Test cases can model both one-shot prompts and gated multi-step workflows.
- [x] LLDs define YAML adapter registration and dynamic loading behavior.
- [x] LLDs define managed image build/cache behavior and ready-image bypass behavior.
- [x] LLDs define normalized usage/cost reporting with per-step, per-model, and total rollups.
- [x] LLDs define scoring from test-case-local assertions, judge assertion thresholds, structured metrics, and project-level score weights.
- [x] LLDs define pluggable output providers with a default file provider.
- [x] LLDs define deterministic MCP and CLI mocking.
- [x] LLDs define result visualization with HTML, JSON, and CSV outputs.
- [x] Design docs describe the target architecture without relying on implementation history.
