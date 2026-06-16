# Local Ollama models through Pi

Use this when you want `harness-evals` to run the Pi adapter against a model served by Ollama on the host machine.

The important difference from cloud providers is network topology:

- host Pi smoke tests use `http://localhost:11434/v1`
- Dockerized harness runs use `http://host.docker.internal:11434/v1`

## 1. Import or pull the Ollama model

For Ollama library models:

```bash
ollama pull qwen2.5-coder:7b
```

For a local GGUF, create an Ollama model from a `Modelfile`:

```bash
mkdir -p ~/models/my-coder
cd ~/models/my-coder

# Put the downloaded GGUF in this directory, then:
cat > Modelfile <<'EOF'
FROM ./model.gguf
PARAMETER temperature 0
PARAMETER top_p 0.95
PARAMETER top_k 64
PARAMETER num_ctx 65536
EOF

ollama create my-coder:q4 -f Modelfile
ollama run my-coder:q4
```

Keep Ollama's context (`num_ctx`) aligned with Pi's model metadata. Coding tasks often need more than 16k tokens; 64k is a useful first target when the model and hardware can handle it.

## 2. Expose Ollama to Docker

Ollama must listen on an address Docker containers can reach.

On macOS with the Ollama app:

```bash
launchctl setenv OLLAMA_HOST 0.0.0.0:11434
pkill -f '/Applications/Ollama.app/Contents/Resources/ollama serve' || true
pkill -x Ollama || true
open -a Ollama
```

On Linux or when running `ollama serve` directly:

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

Verify host and Docker access:

```bash
curl -sS http://127.0.0.1:11434/v1/models
docker run --rm curlimages/curl:latest \
  -sS http://host.docker.internal:11434/v1/models
```

If the Docker check fails, fix Ollama binding before running the harness. The Pi adapter runs inside Docker during evaluations.

## 3. Start with Pi's simple OpenAI-compatible provider

For text-only smoke tests, a `models.json` provider is often enough.

Host Pi config:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false,
        "supportsStore": false,
        "supportsStrictMode": false,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "my-coder:q4",
          "name": "My local coder",
          "reasoning": false,
          "contextWindow": 65536,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

For a harness-only Pi config directory, use the same provider but change `baseUrl` to `http://host.docker.internal:11434/v1`.

```bash
mkdir -p ~/.pi-bench/ollama-agent
# write ~/.pi-bench/ollama-agent/models.json with host.docker.internal
```

Smoke test locally:

```bash
pi -p --no-session --no-context-files \
  --provider ollama --model my-coder:q4 --no-tools \
  'Reply with exactly: ok'
```

## 4. Add a Pi provider extension when tool calls are flaky

Many local GGUF models can answer text prompts but emit pseudo tool calls like `write_file(...)` instead of native OpenAI `tool_calls`, especially in streaming mode. Coding-agent evals need native tool calls so Pi can execute `read`, `write`, `edit`, and `bash`.

Use a custom Pi provider extension when any of these are true:

- raw Ollama returns native `tool_calls` only with `stream: false`
- the model needs `tool_choice: "required"` or `tool_choice: "auto"`
- the model behaves better with tool aliases such as `write_file` instead of Pi's built-in `write`
- Pi shows prose/pseudo-code tool calls and no file changes

Recommended extension behavior:

- register a dedicated provider such as `ollama-tools`
- call Ollama's OpenAI-compatible `/chat/completions` endpoint with `stream: false`
- set `temperature: 0` and `think: false`
- set `tool_choice: "required"` until a mutating tool (`write` or `edit`) has run, then switch to `auto`
- alias Pi tool names to model-friendly names before the request, then map tool names back before returning Pi events

Put the harness copy in a directory with `index.js`, not a single `.mjs` file. The Pi adapter stages out-of-repo resources with a hashed suffix; a single file can become a path such as `provider.mjs-1234abcd`, which Node refuses to load as an extension. A directory keeps a normal `index.js` entrypoint.

Example bench settings:

```bash
mkdir -p ~/.pi-bench/ollama-agent/extensions/ollama-tools-provider
cat > ~/.pi-bench/ollama-agent/settings.json <<'EOF'
{
  "extensions": ["extensions/ollama-tools-provider"],
  "defaultProvider": "ollama-tools",
  "defaultModel": "my-coder:q4",
  "defaultThinkingLevel": "off",
  "hideThinkingBlock": true
}
EOF
```

The extension should default to `http://host.docker.internal:11434/v1` for harness runs. For local host smoke tests against the same bench config, override it:

```bash
PI_CODING_AGENT_DIR=~/.pi-bench/ollama-agent \
PI_OLLAMA_BASE_URL=http://localhost:11434/v1 \
pi -p --no-session --no-context-files \
  --provider ollama-tools --model my-coder:q4 \
  --thinking off --tools read,write,ls \
  'Create smoke.txt containing exactly: local tool call works'
```

Verify that `smoke.txt` is actually created. A zero exit code with no file change means the model produced text, not a tool call.

## 5. Add the harness agent

Add a separate agent so existing cloud Pi config remains unchanged:

```yaml
agents:
  pi-local-ollama:
    adapter: pi
    provider: ollama-tools
    model: my-coder:q4
    args:
      - --thinking
      - off
      - --tools
      - read,bash,edit,write,grep,find,ls
    useCurrentConfig: true
    userConfigDirs:
      - ~/.pi-bench/ollama-agent
    timeoutMs: 1800000
```

If the project has multiple harness configs, keep the Docker and agent recipe blocks aligned when managed-image cache stability matters.

## 6. Run one case first

Build only the image for the case you will run:

```bash
bun run build-images --only <case-id>
```

On macOS, warm recreated `evals/` bind mounts after regenerating cases:

```bash
docker run --rm -v "$PWD/evals/<case-id>:/x:ro" alpine ls /x
```

Run a single smoke case:

```bash
bun run run -- --config harness-evals.pilot.yaml \
  --agents pi-local-ollama \
  --case <case-id> \
  --concurrency 1
```

Then inspect:

```bash
jq '.' .harness-evals/output/latest/results.json
find .harness-evals/runs -maxdepth 2 -name events-summary.json | tail
```

A reward of `0` can still mean the harness path is healthy. Check `steps/run/events-summary.json` to confirm whether the model called tools and edited files.

## Troubleshooting

### `Unknown provider "ollama-tools"`

Pi did not load the extension. Check:

```bash
PI_CODING_AGENT_DIR=~/.pi-bench/ollama-agent \
PI_OLLAMA_BASE_URL=http://localhost:11434/v1 \
pi --list-models ollama-tools --offline
```

For harness-staged configs, prefer `extensions/<name>/index.js` and settings that reference the directory.

### Docker cannot reach Ollama

Confirm Ollama listens on `*:11434`:

```bash
lsof -nP -iTCP:11434 -sTCP:LISTEN
```

Then rerun the Docker curl check. If it still fails, restart Ollama after setting `OLLAMA_HOST=0.0.0.0:11434`.

### Pi exits successfully but no files change

The model likely emitted pseudo tool calls in text. Test Ollama directly with `stream: false`, `temperature: 0`, `think: false`, and `tool_choice: "required"`. If raw Ollama still returns plain text, use a different quantization/model or a server with better tool-call support.

### The model stops after a read-only tool

Some local models call `ls` or `read`, then produce an empty final response. In a custom provider, keep `tool_choice: "required"` until a mutating tool result (`write` or `edit`) is present, then switch to `auto`.

### The first request overflows context

Increase both sides:

- Ollama `num_ctx` in the Modelfile or model options
- Pi model `contextWindow` metadata

Recreate the Ollama model after changing the Modelfile.
