# harness-evals

Reusable coding-agent evaluation harness for running real agent CLIs in isolated Docker workspaces.

## Recommended setup

Start by installing the packaged skill from the npm package:

```bash
npx skills add harness-evals --skill harness-evals
```

Then open your coding agent and ask it to use the skill, for example:

```text
can you setup evals for this project?
```

The skill guides the agent to:

- check whether the `harness-evals` CLI is installed
- ask whether to install the CLI globally or locally in the project when it is missing
- inspect the project structure, package manager, test commands, Docker usage, CI, and existing agent config
- ask what you want to test and how before creating cases
- optionally derive cases from existing sessions, failures, or repeated workflows
- map your goals to eval cases, agents, mocks, assertions, scoring, and reports
- create or update `harness-evals.yaml` and goal-specific eval files
- run `harness-evals list` and a focused first validation run

## After setup

After your agent creates `harness-evals.yaml` and the first goal-specific cases, use the CLI loop directly. If the CLI is installed locally, use your package runner such as `npx harness-evals`, `pnpm exec harness-evals`, or `bunx harness-evals`.

```bash
harness-evals list
harness-evals run --case <case-id> --agents <agent-name>
harness-evals view --open
```

`harness-evals` runs coding agents in Docker. If `docker.image` is set, that ready image is used directly. Otherwise the harness builds and reuses a local managed image from the selected adapters' installation recipes.

Refresh a managed image when upstream packages or the Docker base image changed but the install manifest did not:

```bash
harness-evals run --refresh-managed-image --case <case-id> --agents <agent-name>
```

## Documentation

Start with the bundled docs hub at [`skills/harness-evals/docs/index.md`](skills/harness-evals/docs/index.md), or jump to the [`installation and configuration guide`](skills/harness-evals/docs/installation-and-configuration.md) and [`CLI reference`](skills/harness-evals/docs/cli-reference.md).

Contributor architecture notes live under [`docs/design/index.md`](docs/design/index.md).
