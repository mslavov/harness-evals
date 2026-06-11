# Agents and adapters

Agents are named runtime configurations. An adapter turns an agent config into the command harness-evals runs inside Docker.

## Use a built-in adapter

Built-in adapters are registered automatically:

- `command`: run any CLI command
- `pi`: run the Pi coding agent
- `claude-code`: run Anthropic Claude Code
- `codex`: run OpenAI Codex CLI
- `cursor`: run Cursor Agent

Minimal examples:

```yaml
agents:
  local-command:
    adapter: command
    command: echo
    args: ["{{ prompt }}"]

  pi-gemini:
    adapter: pi
    provider: gemini
    model: gemini-2.5-pro

  claude-sonnet:
    adapter: claude-code
    model: claude-sonnet-4

  codex-gpt5:
    adapter: codex
    model: gpt-5

  cursor-default:
    adapter: cursor
```

## Common agent fields

These fields are shared across adapters:

```yaml
agents:
  example:
    adapter: command
    command: my-agent
    args: ["--flag", "{{ prompt }}"]
    cwd: /workspace
    env: [NODE_ENV]
    envAllowlist: [MY_AGENT_TOKEN]
    timeoutMs: 300000
    parser: text
```

Useful fields:

- `command`: binary to run. Built-ins provide defaults; override when needed.
- `args`: extra arguments. `command` replaces `{{ prompt }}` inside args; if no arg contains the prompt, the prompt is appended.
- `cwd`: working directory inside the container. Defaults to `workspace.containerPath`.
- `env`: extra environment variable names to forward into the container.
- `envAllowlist`: additional env names to forward for this agent.
- `timeoutMs`: per-step timeout override.
- `parser`: output parser. Built-ins default to `text`, except `pi`, which defaults to `pi-jsonl`.

Adapter-specific fields used by built-ins:

- `provider`, `providerEnv`, `model`, `modelEnv`: used by `pi`
- `apiKeyEnv`: forwarded by built-ins that can authenticate with an API key
- `profile`: used by `codex`
- `outputFormat`: used by `claude-code`, `codex`, and `cursor`
- `config`: adapter-specific settings

## Token and cost metrics

`claude-code`, `codex`, and `pi` report per-run token usage (and cost where the CLI
provides it) into the run's cost report, the HTML/CSV report columns, and `cost.json`
artifacts. No configuration is needed:

- `claude-code` defaults to `--output-format json` and reads `usage`/`modelUsage`/
  `total_cost_usd` from the result object.
- `codex` defaults to `codex exec --json` and sums token usage from the JSONL events
  (tokens only; no dollar cost under ChatGPT auth).
- `pi` accumulates usage and cost from its assistant message events.

The json defaults apply only when the agent runs the real CLI binary; agents that
override `command:` keep plain output. Set `outputFormat: text` to opt out (final
output then stays raw stdout and no usage is reported).

## Reuse config with `extends`

Use `extends` to define a base agent and derive variants from it.

```yaml
agents:
  claude-base:
    adapter: claude-code
    model: claude-sonnet-4
    timeoutMs: 300000

  claude-fast:
    extends: claude-base
    model: claude-3-5-haiku

  claude-custom:
    extends: claude-base
    args: ["--verbose"]
```

How merging works:

- child fields override parent fields
- array fields like `args`, `env`, `envAllowlist`, `projectConfigDirs`, and `userConfigDirs` replace the parent value
- `config` is merged shallowly
- `extends` chains are resolved before test-case overrides run
- circular `extends` chains fail during config load

If an agent uses `extends`, it does not need its own `adapter` as long as the parent defines one.

## Current auth and config passthrough

`claude-code`, `codex`, and `cursor` reuse your current local config (skills, settings, plugins, MCP servers, custom commands/agents) inside the container.

Default behavior:

- harness-evals copies a writable **snapshot** of your current config directory into `/agent-config/<adapter>` per run, sets the adapter-specific config env var to point at it, and deletes the copy after the run. A writable copy (not a read-only mount) lets the CLI refresh OAuth tokens and write session state without touching your host config.
- the config copy is **independent of credentials**: it happens even when an auth env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) is already set. The credential env is still forwarded and redacted.
- noisy/large subdirectories (logs, sessions, caches, project history) are excluded by default to keep the snapshot small.

Controls:

```yaml
agents:
  claude:
    adapter: claude-code
    useCurrentConfig: true
    userConfigDirs:
      - ~/.claude
    config:
      configExcludeDirs: [projects]   # extra dirs to skip when copying
      configIncludeDirs: [logs]       # force-keep a default-excluded dir
      mcpConfig: /workspace/.mcp.json # claude: --mcp-config <file>
      strictMcp: true                 # claude: --strict-mcp-config
```

Relevant fields:

- `useCurrentConfig` (alias `config.copyCurrentConfig`): enable or disable the config copy. Defaults to enabled for these built-ins.
- `userConfigDirs`: override the source directory searched on the host. Only the first entry is used.
- `config.configExcludeDirs` / `config.configIncludeDirs`: tune which subdirectories are copied. Overridable per case and per step.
- `config.mcpConfig` / `config.strictMcp` (claude-code only): pass `--mcp-config`/`--strict-mcp-config` for headless MCP loading.
- `config.codexSandbox` / `config.skipGitRepoCheck` (codex only): control the non-interactive `exec` sandbox (default `danger-full-access`, suitable for containerized runs) and the git-repo check.
- `apiKeyEnv`: add your own credential env name to the forwarded env set.

Adapter defaults:

- `claude-code` uses `CLAUDE_CONFIG_DIR`; its sibling `~/.claude.json` (user-scope MCP, trust, settings) is copied alongside the directory. On macOS the login lives in the Keychain, not the copied dir — run `claude setup-token` once and export `CLAUDE_CODE_OAUTH_TOKEN`.
- `codex` uses `CODEX_HOME` (covers `config.toml`, profiles, `[mcp_servers]`, and `auth.json`).
- `cursor` uses `CURSOR_CONFIG_DIR`.

`useCurrentConfig: false` disables the copy entirely; only forwarded credential env vars are used.

### Pi config behavior

The `pi` adapter writes per-run settings files instead of mounting a config directory.

By default it can:

- read provider/model defaults from your current Pi config
- write a generated global settings file into the run config directory
- write a generated project settings file into `workspace/.pi/settings.json`
- copy current Pi auth/model config files into the run config directory when current config is enabled, then remove those copies after the run

Useful Pi fields:

```yaml
agents:
  pi-default:
    adapter: pi
    useCurrentConfig: true
    userConfigDirs:
      - ~/.pi/agent
    projectConfigDirs:
      - .pi
    config:
      globalSettingsTemplate: evals/pi/global-settings.json
      projectSettingsTemplate: evals/pi/project-settings.json
```

Notes:

- `userConfigDirs[0]` points to the host Pi agent directory.
- `projectConfigDirs[0]` changes where harness-evals looks for the current project `.pi/settings.json` source.
- local paths referenced from Pi settings are rewritten to container repo paths when they stay inside the project; paths **outside** the repo (e.g. host-global skills/extensions/packages in `~/...`) are copied into the per-run config dir under `pi-resources/` and rewritten to their container path, then removed after the run.
- Pi runs from the container workspace and sets `PI_CODING_AGENT_DIR` to the per-run config directory.

## Declare a project adapter

Use `adapters` to load an adapter from your repo or from a package resolvable from the project.

```yaml
adapters:
  acme-code:
    module: ./evals/adapters/acme-code.mjs
    export: default

agents:
  acme:
    adapter: acme-code
```

Resolution rules:

- `module` can be a relative project path, an absolute path inside the project root, a project subpath, or a package specifier
- if `export` is omitted, harness-evals tries `default` and then `adapter`
- the exported adapter object must implement `prepareStep` and `parseEvents`
- the adapter may also implement `complete(input)` for headless string-in/string-out LLM calls
- the adapter's `name` must match the declaration key

### Headless completion for judge fallback

Adapters that can answer a single prompt without a full scenario run may expose `complete(input): Promise<string>`.

```ts
export const adapter = {
  name: 'acme-code',
  async prepareStep(input) {
    // normal scenario execution
  },
  async parseEvents(input) {
    return { finalOutput: input.stdout.trim(), toolCalls: [], errors: [] };
  },
  async complete(input) {
    return await callModel(input.input);
  },
};
```

When an `llmJudge` assertion has no explicit `provider`, `model`, or `apiKeyEnv`, harness-evals selects the first configured agent whose adapter implements `complete()`. The adapter receives the full judge prompt in `input.input` and must return a string containing the normal judge JSON. The built-in `pi` adapter implements this by invoking `pi -p`, which reuses the user's configured Pi credentials.

Project adapters can also replace a built-in by reusing its name:

```yaml
adapters:
  command:
    module: ./evals/adapters/command.mjs
```

That override is used everywhere the `command` adapter name appears.

## Apply project and test-case overrides

You can select agents per case and override them without duplicating top-level agent declarations.

```yaml
agents:
  claude:
    adapter: claude-code
    model: claude-sonnet-4

  codex:
    adapter: codex
    model: gpt-5
```

```yaml
id: checkout-refactor
agents:
  include: [claude, codex]
  exclude: [codex]
  overrides:
    "*":
      timeoutMs: 600000
    claude:
      model: claude-opus-4
steps:
  - id: run
    prompt: Fix the bug.
    assert: []
```

Override order for a selected agent is:

1. top-level agent definition
2. test-case defaults (`timeoutMs`, `parser`)
3. `agents.overrides["*"]`
4. `agents.overrides[<agentName>]`
5. CLI overrides such as `--model`, `--provider`, `--timeout-ms`, and `--image`

Use this to keep reusable base agents at the top level and tune only the cases that need different models, timeouts, or adapter config.