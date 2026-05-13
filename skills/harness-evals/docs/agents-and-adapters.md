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
- `outputFormat`: used by `claude-code` and `cursor`
- `config`: adapter-specific settings

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

## Current auth and config mounting

`claude-code`, `codex`, and `cursor` can reuse your current local login/config directory inside the container.

Default behavior:

- if no matching auth env var is already available, harness-evals mounts the current config directory read-only into `/agent-config/<adapter>`
- it also sets the adapter-specific config env var inside the container so the CLI reads that mounted directory
- if an auth env var is already present, the mount is skipped and the env-based credential is used instead

Controls:

```yaml
agents:
  claude:
    adapter: claude-code
    useCurrentConfig: true
    userConfigDirs:
      - ~/.claude
```

Relevant fields:

- `useCurrentConfig`: enable or disable current-config fallback. Defaults to enabled for these built-ins.
- `userConfigDirs`: override the source directory searched on the host. Only the first entry is used.
- `apiKeyEnv`: add your own credential env name to the forwarded env set.

Adapter defaults:

- `claude-code` uses `CLAUDE_CONFIG_DIR`
- `codex` uses `CODEX_HOME`
- `cursor` uses `CURSOR_CONFIG_DIR`

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
- local paths referenced from Pi settings are rewritten to container repo paths when they stay inside the project; paths outside the repo are left unchanged.
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