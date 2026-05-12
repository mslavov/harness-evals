# harness-evals

Reusable coding-agent evaluation harness for running real agent CLIs in isolated Docker workspaces.

## Recommended setup

Start by installing the packaged skill from the npm package:

```bash
npx skills add harness-evals --skill harness-evals
```

Then open your coding agent and ask it to use the skill, for example:

```text
/harness-evals Set up evals for this project and create a first smoke eval.
```

The skill guides the agent to:

- check whether the `harness-evals` CLI is installed
- ask whether to install the CLI globally or locally in the project when it is missing
- inspect the project structure, package manager, test commands, Docker usage, CI, and existing agent config
- map your goals to eval cases, agents, mocks, assertions, scoring, and reports
- create or update `harness-evals.yaml` and eval files
- run `harness-evals list` and a focused first validation run

## Manual CLI quick check

If the CLI is already installed globally, use `harness-evals`. If it is installed locally, use your package runner such as `npx harness-evals`, `pnpm exec harness-evals`, or `bunx harness-evals`.

```bash
harness-evals init
harness-evals list
harness-evals run --case starter-smoke --agents local-command
```

`harness-evals` runs coding agents in Docker. If `docker.image` is set, that ready image is used directly. Otherwise the harness builds and reuses a local managed image from the selected adapters' installation recipes.

## Documentation

Start with the bundled docs hub at [`skills/harness-evals/docs/index.md`](skills/harness-evals/docs/index.md), or jump to the [`installation and configuration guide`](skills/harness-evals/docs/installation-and-configuration.md) and [`CLI reference`](skills/harness-evals/docs/cli-reference.md).

Contributor architecture notes live under [`docs/design/index.md`](docs/design/index.md).
