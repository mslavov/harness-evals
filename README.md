# harness-evals

Reusable coding-agent evaluation harness for running real agent CLIs in isolated Docker workspaces.

```bash
bun install
bun run check
bun run build
harness-evals init
harness-evals run
```

`harness-evals` runs coding agents in Docker. If `docker.image` is set, that ready image is used directly. Otherwise the harness builds and reuses a local managed image from internal image defaults and adapter-provided installation recipes.

The primary setup path is the `harness-evals` agent skill. Install it with the Skills CLI, activate `/harness-evals` in your coding agent, and let the agent configure the framework from the bundled docs.

See [`docs/HDL.md`](docs/HDL.md) and the LLDs under [`docs/lld/`](docs/lld/) for the architecture and schema.
