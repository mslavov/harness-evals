# Mocks

harness-evals supports two mock surfaces:

- CLI mocks: shadow executables inside the run container
- MCP mocks: intercept MCP `tools/call` requests through adapter-installed wrappers

Top-level defaults live in `harness-evals.yaml`:

```yaml
mocks:
  root: evals/mocks
  strict: true
  recordCalls: true
```

- `root` is the fixture root directory
- `strict` controls what happens when a declared mock does not match
- `recordCalls` writes mock call logs into the run artifacts

## Declaring mocks in a test case

```yaml
id: jira-triage
mocks:
  cli:
    jira-cli: jira-success
  mcp:
    github: github-success
steps:
  - id: run
    prompt: Create a ticket and open a GitHub issue.
    assert:
      - type: mockCalled
        name: jira-cli:issue
        surface: cli
      - type: mockCalled
        name: create_issue
        surface: mcp
```

Fixture references can be:

- a fixture name like `jira-success` or `github-success`
- a project-relative path like `evals/mocks/cli/custom.yaml`

If you use a bare name, harness-evals resolves it as:

- `evals/mocks/cli/<name>.yaml` for CLI mocks
- `evals/mocks/mcp/<name>.yaml` for MCP mocks

Path traversal like `../secret` is rejected.

## CLI mocks

Map an executable name to a fixture:

```yaml
mocks:
  cli:
    jira-cli: jira-success
```

CLI mock keys must be executable names, not paths.

A CLI fixture looks like this:

```yaml
name: jira-success
description: Successful issue creation
mocks:
  - id: create-issue
    tool: jira-cli:issue
    match:
      project: STORZY
      summary: '*checkout*'
    response:
      ok: true
      key: STORZY-1
```

Available rule fields:

- `id`
- `tool`
- `match`
- `response`
- `stdout`
- `stderr`
- `exitCode`
- `delayMs`

For CLI mocks, the wrapper turns argv into matchable fields:

- long and short flags become string keys, like `project: STORZY`
- `command`: the executable name, for example `jira-cli`
- `subcommand`: first positional argument, for example `issue`
- `args`: the full argv string
- `positional`: positional args joined as a string

Tool matching works like this:

- `jira-cli:issue` matches the `issue` subcommand
- `jira-cli` matches the command regardless of subcommand

If a rule has `response`, the wrapper prints it as JSON to stdout. If you need exact stdout or stderr text, set `stdout` or `stderr` instead.

## MCP mocks

Map a server name to a fixture:

```yaml
mocks:
  mcp:
    github: github-success
```

An MCP fixture looks like this:

```yaml
name: github-success
mocks:
  - id: create-issue
    tool: create_issue
    match:
      title: '*checkout*'
    response:
      number: 42
      url: https://github.example.local/acme/repo/issues/42
```

For MCP mocks:

- `tool` is the MCP tool name
- `match` checks the request arguments object
- `response` is returned as JSON text content

Adapters must implement MCP mock support. If a case declares `mcp` mocks for an adapter without `applyMcpMocks`, the run fails during setup.

## Strict mode

Strict mode is enabled by default.

### CLI strict mode

If a mocked CLI command is called but no fixture rule matches:

- the wrapper records an unmatched call
- stderr gets `Unmatched CLI mock call: ...`
- exit code becomes `1`
- the step gets a failing error assertion even if you did not write one

### MCP strict mode

If a mocked MCP tool call does not match a rule:

- the wrapper records an unmatched call
- the response is an MCP error
- the step gets a failing error assertion

When `strict: false`:

- unmatched CLI calls exit `0`
- unmatched MCP calls return an empty result when there is no wrapped real server
- if the adapter wraps a real MCP server, unmatched calls can pass through instead of failing

You can override strictness at the case or step level:

```yaml
mocks:
  cli:
    jira-cli: jira-success
  strict: true
steps:
  - id: run
    prompt: Exercise fallback behavior.
    mocks:
      strict: false
    assert: []
```

`recordCalls` is not step-scoped; it comes from top-level mock defaults.

## Step-level overrides

Case-level mocks apply to every step unless a step overrides the same key.

```yaml
mocks:
  cli:
    jira-cli: case-fixture
steps:
  - id: first
    prompt: First run
    assert:
      - type: contains
        value: case mock
  - id: second
    prompt: Second run
    mocks:
      cli:
        jira-cli: step-fixture
    assert:
      - type: contains
        value: step mock
```

Merge behavior:

- case-level CLI mocks + step-level CLI mocks are merged
- case-level MCP mocks + step-level MCP mocks are merged
- if both define the same command or server, the step-level fixture wins
- `strict` resolves as step override, then case override, then top-level default

## Recorded calls

With `recordCalls: true`, harness-evals writes:

- `<runDir>/mock-calls.jsonl`
- `<runDir>/mock-config.json`
- `<runDir>/steps/<step-id>/mock-calls.jsonl`
- `<runDir>/steps/<step-id>/mock-config.json`

Each call record includes the surface, tool name, input, whether it matched, strictness, fixture name/path, rule id, and timestamp.

Use the built-in assertion to verify mock usage:

```yaml
assert:
  - type: mockCalled
    name: jira-cli:issue
    surface: cli
    matched: true
    min: 1
    argsContain: [STORZY]
```

`argsContain` checks the serialized recorded input.

## Fixture tips

- Keep fixture files focused on one external system behavior.
- Prefer exact `tool` names and narrow `match` filters over one catch-all rule.
- Use `delayMs` only when the timing behavior matters to the eval.
- Use stable fixture names; they appear in recorded call metadata.
