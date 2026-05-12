---
name: harness-evals
description: Install, configure, and extend harness-evals for coding-agent evaluation projects.
---

# Harness Evals

Use this skill when the user asks to install, configure, extend, or create tests for harness-evals.

## Reference Docs

Read `docs/index.md` first, then read the task or reference page relevant to the request:

- `docs/getting-started.md`
- `docs/installation-and-configuration.md`
- `docs/concepts.md`
- `docs/cli-reference.md`
- `docs/writing-evals.md`
- `docs/use-cases.md`
- `docs/agents-and-adapters.md`
- `docs/docker-workspaces-and-images.md`
- `docs/mocks.md`
- `docs/scoring-and-judging.md`
- `docs/output-and-reports.md`
- `docs/troubleshooting.md`

## Agent-First Workflow

1. Read `docs/index.md`, then read `docs/installation-and-configuration.md`, `docs/concepts.md`, and the task-specific docs for the user's request.
2. Check for existing harness files before editing: `harness-evals.yaml`, `evals/tests/`, `evals/mocks/`, and package scripts.
3. Check whether the `harness-evals` CLI is available. Try the project/package-manager runner when a local install appears likely, and try `harness-evals --help` for a global install.
4. If the CLI is missing, ask whether to install it globally or locally in the project. Do not install it before the user chooses.
   - Global: install from npm, then verify `harness-evals --help`.
   - Local: detect the package manager, add `harness-evals` as a dev dependency, then verify with the matching runner such as `npx harness-evals --help`, `pnpm exec harness-evals --help`, or `bunx harness-evals --help`.
5. Inspect the project package manager, language, test commands, Docker usage, existing CI, and existing coding-agent configuration.
6. If the active coding agent is unclear, ask which agent is being used.
7. Ask what the user wants to achieve: compare agents, create a regression suite, validate project-specific behavior, mock external tools, score outputs, or improve failure triage.
8. Translate that goal into harness capabilities: agents/adapters, suites and test cases, fixtures, mocks, assertions, judge/scoring settings, output reports, and Docker image mode.
9. Ask which additional agents should be evaluated, then map selected agents to built-in adapters when possible; create project adapters only when the user asks for unsupported agents.
10. Create or update `harness-evals.yaml` with minimal config: `tests` discovery, selected `agents`, default file output, visualization defaults, judge defaults only when judge assertions are used, and scoring defaults.
11. Leave `docker.image` unset unless the user already has a ready image.
12. Create test cases under `evals/tests/` and mock fixtures under `evals/mocks/` only when needed.
13. Run `harness-evals list` and a focused first `harness-evals run --case <id> --agents <agent>` validation, using the local package runner when the CLI was installed locally.
14. Report created files, selected agents, test cases, validation results, and next commands.

## Safety Rules

- Ask one focused question at a time when required inputs are missing.
- Ask before installing the CLI, adding dependencies, creating test cases, configuring additional agents, or overwriting harness files.
- Never write API keys, tokens, passwords, or secret values into repo files.
- Use environment variable names for credentials, for example `OPENAI_API_KEY` or `PI_EVAL_API_KEY`.
- Do not expose managed-image base image or tag-prefix settings.
- Do not configure pricing tables.
- Read existing harness files before editing and merge with user approval.
