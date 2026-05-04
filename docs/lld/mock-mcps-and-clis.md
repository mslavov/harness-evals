# LLD — Mocking MCPs and CLIs

> **HLD:** `../HDL.md`
> **Companion LLDs:** `agent-first-install-and-config.md`, `scenario-runner.md`, `adapter-registry-and-contract.md`, `managed-images.md`, `validation-scoring-and-judging.md`, `cost-and-artifacts.md`, `output-providers.md`, `result-visualization.md`
> **Status:** Draft

## How this fits

This LLD defines deterministic mocks for external MCP servers and command-line tools. It preserves the HLD invariants for workspace isolation, adapter boundaries, deterministic measurement, output-provider persistence, and test-case-local assertions.

Test cases declare MCP and CLI stubs, the harness stages wrapper scripts/config into the isolated run, wrappers match tool invocations against YAML mock fixtures, return configured responses, and record every mock call for assertions and artifacts.

## 1. Domain Overview

Coding-agent evals often need to exercise integrations such as Slack, Jira, GitHub, browser automation, deployment CLIs, issue trackers, and custom MCP servers. Real integrations make evals slow, flaky, expensive, and risky. Mocking makes those integrations deterministic while still requiring the agent to call the same tools or CLIs it would use in production.

The harness supports two mock surfaces:

1. **CLI mocks:** Executable wrapper scripts are placed ahead of real commands on `PATH`. A call such as `slack-cli post-rich-message --channel qa` is handled by the wrapper, matched against a mock fixture, and returned as deterministic stdout/stderr/exit code.
2. **MCP mocks:** Configured MCP servers are wrapped with a stdio JSON-RPC interceptor. The wrapper can pass through lifecycle and `tools/list` calls to the real server while intercepting selected `tools/call` requests. It can also run in standalone mode when no real server is needed.

Mocks are test data. They live under `evals/mocks/` by default and are referenced by individual test cases or steps. `harness-evals.yaml` can configure mock defaults and fixture roots, but it does not need to list every mock fixture.

## 2. Data Model / Contracts

### Default project shape

```text
evals/
  tests/
    checkout-refactor.yaml
  mocks/
    cli/
      slack-success.yaml
      jira-not-a-bug.yaml
    mcp/
      github-success.yaml
      playwright-success.yaml
```

### Harness config shape

Mock config is optional. Omitting it enables the defaults below.

```yaml
mocks:
  root: evals/mocks
  strict: true
  recordCalls: true
```

Fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `root` | no | Project-relative mock fixture root. Defaults to `evals/mocks`. |
| `strict` | no | Default strictness. When true, unmatched mocked CLI/MCP calls fail. Defaults to true. |
| `recordCalls` | no | Whether wrappers write call logs for assertions/artifacts. Defaults to true. |

### Test case mock declarations

A test case can declare mock fixtures for the whole test case:

```yaml
id: run-tests-happy-path
mocks:
  cli:
    jira-cli: jira-cloud-success
    slack-cli: slack-success
  mcp:
    github: github-success
    playwright: playwright-success
steps:
  - id: run
    prompt: Run tests and file any product bugs.
```

A step can override or add mocks for that step only:

```yaml
id: deployment-check
mocks:
  cli:
    vercel: vercel-success
steps:
  - id: inspect
    prompt: Inspect the linked deployment.
  - id: retry-failed-deploy
    prompt: Re-check the deployment after the retry.
    mocks:
      cli:
        vercel: vercel-retry-success
```

Mock declaration rules:

1. Test-case mocks apply to every step.
2. Step mocks shallow-merge over test-case mocks for the current step.
3. `cli.<command>` names the executable that should be shadowed on `PATH`.
4. `mcp.<serverName>` names the MCP server entry in the agent's MCP config.
5. Values are mock fixture names resolved under `mocks.root/cli` or `mocks.root/mcp` with `.yaml` appended when no extension is present.
6. Project-relative paths can be used when a mock fixture is outside the default mock root.

### Mock fixture file

CLI and MCP mock fixtures share one rule shape.

```yaml
name: slack-success
description: Mock slack-cli operations
mocks:
  - id: list-channels
    tool: slack-cli:list-channels
    response:
      channels:
        - { id: C123456, name: qa-alerts }

  - id: post-rich-message
    tool: slack-cli:post-rich-message
    match:
      channel: '*'
    response:
      ok: true
      ts: '1234567890.123456'
```

For CLIs, `tool` is either the command name or `<command>:<subcommand>`. The wrapper parses positional subcommands and `--key value` arguments into the match input.

For MCP, `tool` is the MCP tool name received in `tools/call.params.name`. The wrapper matches `tools/call.params.arguments`.

```yaml
name: github-success
mocks:
  - tool: create_issue
    match:
      title: '*checkout*'
    response:
      number: 42
      url: https://github.example.local/acme/repo/issues/42
```

### Contracts

```ts
interface MockConfig {
  root: string;
  strict: boolean;
  recordCalls: boolean;
}

interface TestCaseMockConfig {
  cli?: Record<string, string>;
  mcp?: Record<string, string>;
  strict?: boolean;
}

interface MockFixture {
  name: string;
  description?: string;
  mocks: MockRule[];
}

interface MockRule {
  id?: string;
  tool: string;
  match?: Record<string, string>;
  response?: unknown;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
}

interface MockRuntimePlan {
  cliPath?: string;
  envValues: Record<string, string>;
  configMounts: ConfigMount[];
  mcpWrappers: Record<string, McpMockWrapperPlan>;
  callLogPaths: string[];
  metadata: Record<string, unknown>;
}

interface McpMockWrapperPlan {
  serverName: string;
  fixturePath: string;
  strict: boolean;
  recordPath?: string;
  wrapperCommand: string[];
}
```

### Adapter integration contract

Adapters own agent-specific MCP config generation. The mock runtime prepares generic wrapper plans, and adapters apply those plans to their config format.

```ts
interface AgentStepPrepareInput {
  // existing fields omitted
  mocks?: MockRuntimePlan;
}

interface AgentAdapter {
  // existing methods omitted
  applyMcpMocks?(input: ApplyMcpMocksInput): Promise<ApplyMcpMocksResult>;
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
```

Rules:

1. If a test case declares MCP mocks and the selected adapter cannot apply MCP mock wrappers, the run fails before Docker execution with an actionable adapter capability error.
2. CLI mocks are adapter-agnostic because they are injected through `PATH`.
3. MCP mocks are adapter-aware because each agent stores MCP server config differently.
4. The adapter preserves unmocked MCP server entries unchanged.
5. When wrapping a real MCP server, the wrapper forwards `tools/list` and non-mocked methods so the agent sees the real tool surface.

## 3. Lifecycle / State Transitions

### Mock lifecycle

```text
test case loaded
  -> resolve test-case and step mock declarations
  -> load mock fixture YAML
  -> stage CLI wrappers and MCP wrapper config under run config
  -> adapter applies MCP wrappers to agent config
  -> Docker run executes with mock env, PATH, and config mounts
  -> wrappers record calls
  -> harness collects mock call logs
  -> emit mock output records
  -> assertions and scoring consume mock calls
```

### CLI mock lifecycle

```text
agent invokes command
  -> shell resolves command from mock PATH prefix
  -> wrapper parses command/subcommand/flags
  -> matcher selects first matching rule
  -> response stdout/stderr/exitCode returned
  -> call log appended
```

### MCP mock lifecycle

```text
agent starts MCP server
  -> adapter-configured command starts harness MCP wrapper
  -> wrapper optionally starts real server with --wrap
  -> initialize/tools/list pass through or respond from mock fixture
  -> tools/call matched against rules
       |-- match -> return mocked result
       |-- no match + strict -> return JSON-RPC error
       `-- no match + passthrough -> forward to wrapped server
  -> call log appended
```

Rules:

1. Matching is first-match-wins in mock fixture file order.
2. `match` values use simple glob semantics: `*`, prefix, suffix, contains, or exact match.
3. Missing `exitCode` means `0` for CLI mocks.
4. Missing `stdout` with `response` means the CLI wrapper prints JSON.
5. MCP `response` values are returned as MCP text content containing serialized JSON unless a future typed-content format is added.
6. Strict mode is the default for mocked surfaces so unplanned external calls are visible.
7. Wrappers never receive real secrets unless the test case explicitly passes them through env allowlists.

## 4. Read Path / Write Path

### Read path

1. Read top-level `mocks` defaults from `harness-evals.yaml`.
2. Read `mocks` declarations from the test case and current step.
3. Resolve mock fixture files under `evals/mocks/cli` and `evals/mocks/mcp`.
4. Read adapter MCP capability metadata.
5. Read wrapper call logs after each step.

### Write path

1. Write merged CLI mock fixtures and executable wrappers under the run config directory.
2. Write MCP wrapper config and call-log paths under the run config directory.
3. Let adapters write agent-specific MCP config that points selected servers at the wrapper.
4. Emit `mock.config` after mocks are staged.
5. Emit `mock.call` records after each step from recorded wrapper logs.
6. Include mock metadata and call-log artifact paths in `step.completed` and `run.result` records.

Output record examples:

```json
{
  "type": "mock.config",
  "stepId": "run",
  "payload": {
    "cli": { "jira-cli": "jira-cloud-success" },
    "mcp": { "github": "github-success" },
    "strict": true
  }
}
```

```json
{
  "type": "mock.call",
  "stepId": "run",
  "payload": {
    "surface": "cli",
    "tool": "jira-cli:issue",
    "input": { "action": "create", "project": "STORZY" },
    "matched": true,
    "ruleId": "create-issue",
    "exitCode": 0
  }
}
```

## 5. Failure Modes

| Failure mode | Symptom | Detection | Remediation |
| --- | --- | --- | --- |
| Missing mock fixture | Config load or run preparation fails | Mock fixture file cannot be resolved | Add the mock fixture file or fix the mock reference |
| Invalid mock fixture | Config load fails | Missing `name`, invalid `mocks`, invalid rule fields | Fix the mock fixture YAML |
| Unmatched CLI call in strict mode | Command exits non-zero | Wrapper has no matching rule | Add a mock rule or disable strict mode for that test |
| Unmatched MCP call in strict mode | MCP `tools/call` returns JSON-RPC error | Wrapper has no matching rule | Add a mock rule or disable strict mode for that test |
| Adapter cannot wrap MCP config | Run fails before Docker execution | Adapter lacks `applyMcpMocks` | Add adapter MCP mock support or remove MCP mocks |
| Mock shadows wrong command | Agent receives mock when a real CLI was expected | PATH prefix includes that command | Remove the CLI mock entry or rename the command |
| Mock response hides integration bug | Test passes with unrealistic response | Review mock fixture and assertions | Keep mocks minimal and representative; add assertions on call inputs |
| Call logs missing | Mock assertions cannot inspect calls | Wrapper record path missing or write failed | Enable `recordCalls` and ensure config dir is writable |

## 6. Trade-Offs Accepted

- YAML mock fixtures are simple and reviewable.
- CLI mocks use PATH shadowing because it is portable across agents and keeps prompts/config realistic.
- MCP mocks use stdio wrapping because most coding-agent MCP integrations communicate through JSON-RPC over stdio.
- Adapters apply MCP mock wrappers because MCP config paths and formats differ by agent.
- The wrapper can pass through `tools/list` to a real server so mocked runs preserve realistic tool discovery.
- Strict mode defaults to true because deterministic evals should fail on unplanned external calls.

## 7. Design Decisions

### Accepted decisions

- Test cases can declare CLI and MCP mocks.
- Test-case mocks apply to every step; step mocks can override them.
- Mock fixtures live under `evals/mocks/cli` and `evals/mocks/mcp` by default.
- CLI and MCP mocks share a common mock fixture/rule shape.
- CLI wrappers are staged into the run config and injected through `PATH`.
- MCP wrappers intercept JSON-RPC `tools/call` and can pass through to wrapped real servers.
- Mock calls are emitted as output records and are available to assertions and scoring.
- Adapter support is required for MCP mocks because adapters own agent config generation.

### Open decisions

- Whether mock fixtures should support ordered call expectations in addition to first-match response rules.
- Whether MCP typed content responses should be represented separately from serialized JSON text.
- Whether the first release should support HTTP-based MCP transports or stdio only.
