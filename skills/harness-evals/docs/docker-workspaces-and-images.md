# Docker workspaces and images

harness-evals runs agent steps in Docker. Each scenario gets its own copied workspace and per-run config directory.

## How isolation works

For each matrix entry, harness-evals creates a run directory with:

- `workspace/`: the files the agent can edit
- `config/`: per-run config files written by adapters
- `steps/`: logs, parsed events, assertions, and artifacts

The container mounts:

- the run workspace at `workspace.containerPath` (default `/workspace`)
- the run config directory at `docker.configRoot` (default `/agent-config`)

The workspace mount is writable. Extra adapter config mounts, such as mounted auth directories, are read-only.

## Workspaces are copied, not bind-mounted from your repo

`workspace.mode` is currently `copy`.

That means harness-evals:

1. copies files from `workspace.source` into the run workspace
2. runs every step for that scenario against the copied workspace
3. computes diffs from the copied workspace, not from your original repo

Your source repo is left untouched by the agent run itself.

Default ignore rules exclude common large or generated directories:

- `.git`
- `node_modules`
- `.harness-evals`
- `.pi-evals`
- `evals/output`

Add your own ignore entries with `workspace.ignore`.

```yaml
workspace:
  source: .
  mode: copy
  containerPath: /workspace
  ignore:
    - dist
    - coverage
```

## Use fixtures for cleaner scenarios

A fixture lets a case start from a prepared subdirectory instead of copying the whole repo.

Per case:

```yaml
id: checkout-refactor
workspace:
  fixture: evals/fixtures/checkout
steps:
  - id: run
    prompt: Fix the checkout bug.
    assert: []
```

Behavior:

- if `workspace.fixture` is set on the test case, harness-evals copies that fixture into the run workspace
- otherwise it copies `workspace.source`
- the same copied workspace is shared across all steps in the scenario

Fixture paths are resolved relative to the project root and path traversal outside the project is rejected.

## Ready image vs managed image

Choose one of two Docker image modes.

### Ready image: `docker.image`

Set `docker.image` when you already have an image with the required CLIs installed.

```yaml
docker:
  image: my-agent-runtime
  timeoutMs: 300000
```

What happens:

- harness-evals uses that image directly
- it still runs adapter probes before execution
- if a probe fails, the run stops with an actionable error
- no image build happens

You can also override the configured image for a run with the CLI `--image` flag.

### Managed image: omit `docker.image`

If `docker.image` is omitted, harness-evals builds a managed runtime image automatically during the run.

What goes into that image:

- the install recipe returned by each selected adapter
- adapter-defined package installs, setup commands, and probes

Managed images are:

- built only when needed for the selected agents
- cached by an install manifest key
- re-probed when reused
- rebuilt if a cached image no longer passes probes

Use `--refresh-managed-image` when the install manifest is unchanged but upstream packages or the base image may have changed:

```bash
harness-evals run --refresh-managed-image
```

Refresh mode skips the cached-image reuse path, builds with Docker `--pull` and `--no-cache`, runs probes after the build, and records `cacheHit: false` in `image-resolution.json`. The flag does not rebuild or mutate a user-supplied ready image.

You do not need a separate Docker build step in your project config.

## Environment allowlists

Docker does not receive your whole host environment.

Variables get into the container from three places:

- `docker.envAllowlist`: global allowlist for all agents
- `agent.env` and `agent.envAllowlist`: agent-specific additions
- adapter-added env names such as auth envs and `apiKeyEnv`

Default global allowlist includes common LLM API key names such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and similar provider key vars.

Example:

```yaml
docker:
  envAllowlist:
    - ANTHROPIC_API_KEY
    - OPENAI_API_KEY
    - GITHUB_TOKEN

agents:
  claude:
    adapter: claude-code
    envAllowlist:
      - JIRA_API_TOKEN
```

Use the smallest allowlist you need. Values are forwarded from the current host environment at runtime.

## Working directories inside the container

By default, adapters run with:

- working directory: `workspace.containerPath`
- repo root path exposed to adapter config: `docker.repoPath`
- home directory: `docker.home`

Defaults are:

```yaml
workspace:
  containerPath: /workspace

docker:
  repoPath: /workspace
  home: /home/harness
  configRoot: /agent-config
```

Override `agent.cwd` only when an agent must start somewhere else inside the copied workspace.

## Verifier network policy

Agent steps use Docker's default network unless your Docker daemon or image changes it. Post-agent verifiers are stricter: when `verifier.network` is omitted, harness-evals runs the verifier with `--network none`.

```yaml
verifier:
  command: bun
  args: [test]
  network:
    mode: none
```

Supported verifier modes:

- `none`: passes `--network none` to Docker.
- `default`: leaves Docker networking at its default.
- `allowlist`: uses Docker bridge networking and exposes `HARNESS_EVALS_NETWORK_ALLOWLIST` inside the verifier container as a comma-separated allowlist for verifier tooling or proxies.

Prefer `none` for hidden tests and deterministic checks. Use `default` or `allowlist` only when the verifier intentionally needs network access.

## Practical setup patterns

Use a ready image when:

- you already maintain a team image
- installation is slow or requires system packages you want to control directly
- you want fully predictable tool versions

Use managed images when:

- you want the simplest setup
- you are evaluating built-in adapters without maintaining Dockerfiles
- you want the runtime image to follow the selected adapters automatically

Use fixtures when:

- the repo is large but each eval only needs a small slice
- each scenario should start from a known clean state
- you want diffs and artifacts focused on the code under test
