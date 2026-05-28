# CLI reference

`harness-evals` defaults to `run` when you do not pass a command.

## Common behavior

- `--config <path>`: use a specific config file. If omitted, `harness-evals` searches upward from the current working directory for `harness-evals.yaml`.
- `--help`, `-h`: print CLI help.
- Unknown commands or flags fail immediately.

## Commands

### `run`

Run the selected case/agent matrix.

```bash
harness-evals run [--config path] [--suite name] [--case id] [--agents a,b] [--concurrency n] [--attempts n]
```

Flags:

- `--suite <name>`: run only cases in one suite.
- `--case <id>`: run only one case ID.
- `--agents <a,b>`: run only the named agents (comma-separated).
- `--concurrency <n>`: run up to `n` matrix entries at once.
- `--attempts <n>`: override case-level attempt counts for selected cases.
- `--provider <name>`: override the provider for selected agents.
- `--model <name>`: override the model for selected agents.
- `--timeout-ms <n>`: override the per-run timeout.
- `--image <ref>`: use a ready Docker image for all selected runs and skip managed image builds.
- `--refresh-managed-image`: rebuild the selected managed image before running, using Docker `--pull` and `--no-cache`.

Output:

- Prints one row per case/agent result, including artifact path.
- Prints `Summary: <path>` for the harness summary output.
- Exits with code `0` when all selected runs pass, `1` when any run fails or the command errors.

### `list`

List configured agents, cases, and the size of the selected matrix.

```bash
harness-evals list [--config path]
```

Useful filters:

- `--suite <name>`
- `--case <id>`
- `--agents <a,b>`
- `--image <ref>`
- `--refresh-managed-image` (accepted for parity with `run`; it only annotates managed-image output)

Output includes:

- agent names and adapters
- case IDs and suites
- matrix entry count after filters
- runtime image mode: ready image vs managed image

### `view`

Locate or serve rendered reports.

```bash
harness-evals view [--config path] [--run id] [--latest] [--open] [--port n]
```

Flags:

- `--run <id>`: target a specific run directory under the artifact root.
- `--latest`: accepted by the CLI; current behavior already defaults to the latest report when `--run` is not set.
- `--open`: open the file path or local server URL.
- `--port <n>`: start a local HTTP server on `127.0.0.1:<n>` instead of just printing the file path.

Behavior:

- With `--run`, resolves `<artifactRoot>/<run-id>/index.html`.
- Without `--run`, resolves `<outputRoot>/latest/results.html`.
- With `--port`, serves `/runs/...` and `/latest/...` report assets until interrupted.

### `export`

Copy or render a report to a specific output file.

```bash
harness-evals export [--config path] [--run id] --format html|json|csv --output path
```

Required flags:

- `--format <html|json|csv>`
- `--output <path>`

Optional flags:

- `--run <id>`: export a specific historical run.

Behavior:

- Without `--run`, copies `<outputRoot>/latest/results.<format>`.
- With `--run`, reads `<artifactRoot>/<run-id>/result.json` and renders the requested format.
- Creates parent directories for `--output` automatically.
- Fails if visualization is disabled or the requested format is not enabled in config.

## Docker image behavior

`harness-evals` has two runtime image modes:

- Ready image: set `docker.image` in config or pass `--image <ref>` to use an existing image.
- Managed image: if no ready image is configured, `harness-evals run` builds one automatically for the selected agents, caches it, and reuses it on later runs when possible.

Ready image behavior:

- The CLI probes the image to confirm required tools are present.
- If probes fail, the run stops and asks you to supply a suitable image or remove the ready-image setting so managed image resolution can be used.

Managed image behavior:

- The image is built from the install recipes required by the selected agents.
- Cached images are probed before reuse; if a cached image fails probes, it is rebuilt.
- Pass `--refresh-managed-image` to bypass cached-image reuse and rebuild the managed image with Docker `--pull` and `--no-cache`.
- There is no separate Docker build workflow to run first.

If you call the `docker` command directly, the CLI fails with guidance to use `run` and either let managed builds happen automatically or supply `docker.image` / `--image`.
