# LLD — Adapter Registry and Contract

> **HLD:** `../HDL.md`
> **Companion LLDs:** `agent-first-install-and-config.md`, `scenario-runner.md`, `managed-images.md`, `validation-scoring-and-judging.md`, `cost-and-artifacts.md`, `output-providers.md`, `mock-mcps-and-clis.md`, `result-visualization.md`
> **Status:** Draft

## How this fits

This LLD defines the adapter registry and adapter contract that enforce the HLD invariants for adapter boundaries, config-declared extensibility, managed image installation recipes, multi-step continuation, MCP mock integration, event parsing, and usage/cost reporting.

## 1. Domain Overview

The adapter registry resolves every adapter name referenced by an agent before the test-case matrix runs. Built-in adapters are available by default. Project-defined adapters are declared in `harness-evals.yaml`, loaded dynamically, validated, and then treated the same as built-ins by the test-case runner and image resolver.

Adapters own provider-specific behavior. The runner does not know how a CLI accepts prompts, resumes across steps, emits events, reports usage, installs itself, locates config files, or represents MCP server config. The adapter contract normalizes those details into run plans, event summaries, continuation metadata, MCP mock application, install recipes, probes, and cost usage records.

## 2. Data Model / Contracts

### YAML registration

```yaml
adapters:
  acme-code:
    module: ./evals/adapters/acme-code.js
    export: default

agents:
  acme-sonnet:
    adapter: acme-code
    label: Acme Sonnet
    config:
      provider: acme
      model: sonnet-latest
      apiKeyEnv: ACME_API_KEY
      reasoningEffort: high
```

Adapter declaration fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `module` | yes | Project-relative path or package specifier that exports an adapter. |
| `export` | no | Named export to read from the module. Defaults to `default`, then `adapter`. |

If a project-defined adapter uses the same name as a built-in adapter, the project-defined adapter wins. This is the intentional override mechanism.

### Registry contract

```ts
interface AdapterDeclaration {
  module: string;
  export?: string;
}

interface AdapterRegistryInput {
  projectRoot: string;
  declarations: Record<string, AdapterDeclaration>;
  builtIns: AgentAdapter[];
}

interface AdapterRegistry {
  get(name: string): AgentAdapter | undefined;
  require(name: string): AgentAdapter;
  list(): AgentAdapterMetadata[];
}

interface AgentAdapterMetadata {
  name: string;
  source: 'built-in' | 'project';
  module?: string;
  version?: string;
}
```

### Adapter contract

```ts
interface AgentAdapter {
  name: string;
  version?: string;
  getInstallRecipe?(input: AdapterInstallInput): Promise<AdapterInstallRecipe | undefined>;
  applyMcpMocks?(input: ApplyMcpMocksInput): Promise<ApplyMcpMocksResult>;
  complete?(input: AgentCompletionInput): Promise<string>;
  prepareStep(input: AgentStepPrepareInput): Promise<AgentStepRunPlan>;
  parseEvents(input: AgentEventInput): Promise<AgentEventsSummary>;
}

interface ResolvedAgentConfig {
  name: string;
  adapter: string;
  label?: string;
  timeoutMs?: number;
  env?: string[];
  envAllowlist?: string[];
  config: Record<string, unknown>;
  raw: Record<string, unknown>;
}

interface AdapterInstallInput {
  projectRoot: string;
  agentName: string;
  agent: ResolvedAgentConfig;
  docker: DockerConfig;
}

interface AgentCompletionInput {
  projectRoot: string;
  agentName: string;
  agent: ResolvedAgentConfig;
  input: string;
}

interface AgentStepPrepareInput {
  projectRoot: string;
  agentName: string;
  agent: ResolvedAgentConfig;
  testCase: TestCaseDefinition;
  step: TestCaseStepDefinition;
  stepIndex: number;
  prompt: string;
  runDir: string;
  stepDir: string;
  workspaceDir: string;
  configDir: string;
  workspace: WorkspaceConfig;
  docker: DockerConfig;
  mocks?: MockRuntimePlan;
  continuation?: AdapterContinuation;
}

interface AgentStepRunPlan {
  argv: string[];
  cwd: string;
  envNames: string[];
  envValues?: Record<string, string>;
  configMounts: ConfigMount[];
  parser: string;
  metadata?: Record<string, unknown>;
  cleanupPaths?: string[];
  timeoutMs?: number;
  continuation?: AdapterContinuation;
}

interface AdapterContinuation {
  id?: string;
  metadata?: Record<string, unknown>;
}

interface ApplyMcpMocksInput {
  agentName: string;
  configDir: string;
  workspaceDir: string;
  mcpWrappers: Record<string, McpMockWrapperPlan>;
}

interface ApplyMcpMocksResult {
  wrappedServers: string[];
  unchangedServers: string[];
  metadata?: Record<string, unknown>;
}

interface AgentEventInput {
  stdout: string;
  stderr: string;
  plan: AgentStepRunPlan;
}

interface AgentEventsSummary {
  finalOutput: string;
  toolCalls: Array<{ name: string; args?: unknown; result?: unknown; isError?: boolean }>;
  errors: string[];
  cost?: CostReport;
}
```

### Install recipe contract

```ts
interface AdapterInstallRecipe {
  basePackages?: string[];
  commands: string[];
  probes: AdapterProbe[];
  cacheKey?: string;
}

interface AdapterProbe {
  command: string[];
  expectedExitCode?: number;
}
```

The adapter supplies installation commands for a managed image through `getInstallRecipe`. The recipe can depend on the resolved agent config. Probes validate either a managed image after build or a consumer-provided ready image before execution.

## 3. Lifecycle / State Transitions

### Registry lifecycle

```text
uninitialized
  -> load-built-ins
  -> read-yaml-declarations
  -> import-project-modules
  -> validate-adapter-contracts
  -> ready
```

Rules:

1. Built-in adapters are registered first.
2. Project-defined adapters are registered after built-ins and override built-ins with the same name.
3. Adapter modules are resolved relative to the config file project root unless the module string is a package specifier.
4. Imported values must satisfy the adapter contract before matrix construction.
5. Agents referencing unknown adapters fail config loading before any Docker run starts.
6. Each resolved agent config is passed to the adapter, including adapter-specific `config` and the raw agent entry.
7. Adapter install recipes are collected from selected matrix entries by calling `getInstallRecipe` and passed to the image resolver.

### Step lifecycle integration

```text
test-case runner
  -> registry.require(agent.adapter)
  -> adapter.applyMcpMocks(input) when MCP mocks are declared
  -> adapter.prepareStep(input)
  -> docker run(plan)
  -> adapter.parseEvents(output)
  -> assertions/scoring/cost aggregation
```

The same `prepareStep` method handles one-shot test cases and each step in a multi-step test case. The runner passes prior continuation metadata and any staged mock runtime plan when they exist; the adapter may return new continuation metadata for the next step.

## 4. Read Path / Write Path

### Read path

1. Read `adapters` declarations from `harness-evals.yaml`.
2. Import project-defined adapter modules.
3. Read adapter install recipes from selected adapters.
4. Read adapter metadata and capabilities for output records and summaries.

### Write path

1. Registry writes no runtime output directly.
2. The test-case runner emits adapter plan metadata as step output records.
3. The image resolver emits install manifest and probe results as image-resolution output records.
4. Adapter cleanup paths are removed after the step or test-case run according to the run plan.

## 5. Failure Modes

| Failure mode | Symptom | Detection | Remediation |
| --- | --- | --- | --- |
| Unknown adapter name | Config load fails before matrix execution | Agent references name absent from registry | Add an adapter declaration or use a built-in adapter name |
| Unintended built-in override | A built-in adapter behaves differently because a project adapter uses the same name | Registry metadata shows `source: project` for that adapter name | Rename the project adapter if override was accidental |
| Module import fails | Config load fails with module path/package error | Dynamic import error | Fix module path, build the adapter module, or install the package |
| Invalid adapter export | Config load fails with contract validation error | Missing `name`, `prepareStep`, or `parseEvents`, or non-function optional hooks | Export a valid adapter object |
| Install recipe probe fails | Managed or ready image is rejected | Probe exit code mismatch | Fix adapter install commands or supply a ready image with required tools |
| Event parsing fails | Step result contains adapter parse error | Adapter throws or returns invalid summary | Fix parser logic and preserve raw stdout/stderr output records |
| Missing cost data | Cost rollup marks cost unavailable | Adapter summary omits `cost` | Add adapter extraction for the coding agent's reported session totals |
| MCP mock unsupported | Run fails before Docker execution | Test case declares MCP mocks and adapter lacks `applyMcpMocks` | Add adapter MCP mock support or remove the MCP mock declaration |

## 6. Trade-Offs Accepted

- Adapter modules are trusted project code because they can execute during config loading and can define Docker install commands.
- The registry uses explicit YAML declarations instead of filesystem auto-discovery to keep adapter loading auditable.
- Project-defined adapters override built-ins by name because the YAML config is the source of truth for the run.
- Adapter-specific agent options live under `agents.<name>.config` and are passed through without harness interpretation.
- Adapters apply MCP mock wrappers because each agent stores MCP server config differently.
- The adapter contract exposes one `prepareStep` method rather than separate one-shot and continuation methods because one-shot is a single-step test case.
- Install recipes are produced by adapters, while image build mechanics live in the managed-image layer.

## 7. Design Decisions

### Accepted decisions

- `harness-evals.yaml` contains an `adapters` map for project-defined adapters.
- Agents reference adapters by name through `agents.<name>.adapter`.
- Custom adapters can be loaded from project-relative modules or package specifiers.
- A project-defined adapter with the same name as a built-in adapter overrides the built-in adapter.
- The adapter receives the resolved agent config, including adapter-specific `config` and the raw agent entry.
- Adapter continuation metadata is opaque to the runner.
- Adapters that support MCP config expose `applyMcpMocks` for deterministic MCP mocking.
- Adapters report normalized usage and cost totals through `AgentEventsSummary.cost`.
- Adapter install commands and probes are produced through the adapter contract and can depend on resolved agent config.

### Open decisions

- Whether package-specifier adapter loading requires an allowlist in config.
- Whether adapter modules should be required to be JavaScript at runtime or whether TypeScript loading is supported through the host runtime.
