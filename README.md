# harness-evals

Reusable coding-agent evaluation harness for running real agent CLIs in isolated Docker workspaces.

```bash
bun install
bun run check
bun run build
npx skills add harness-evals --skill harness-evals
# activate /harness-evals in your coding agent
```

For a local starter config and smoke test case, run:

```bash
harness-evals init
harness-evals list
harness-evals run --case starter-smoke --agents local-command
```

`harness-evals` runs coding agents in Docker. If `docker.image` is set, that ready image is used directly. Otherwise the harness builds and reuses a local managed image from internal image defaults and adapter-provided installation recipes.

The primary setup path is the packaged `harness-evals` agent skill under [`skills/harness-evals/SKILL.md`](skills/harness-evals/SKILL.md). Install it with the Skills CLI, activate `/harness-evals` in your coding agent, and let the agent configure the framework from the bundled docs.

See [`skills/harness-evals/docs/HDL.md`](skills/harness-evals/docs/HDL.md) and the LLDs under [`skills/harness-evals/docs/lld/`](skills/harness-evals/docs/lld/) for the architecture and schema.
