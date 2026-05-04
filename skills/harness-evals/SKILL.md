---
name: harness-evals
description: Install, configure, and extend harness-evals for coding-agent evaluation projects.
---

# Harness Evals

Use this skill when the user asks to install, configure, extend, or create tests for harness-evals.

## Reference Docs

Read `docs/HDL.md` first, then read the LLDs relevant to the task:

- `docs/HDL.md`
- `docs/lld/agent-first-install-and-config.md`
- `docs/lld/scenario-runner.md`
- `docs/lld/adapter-registry-and-contract.md`
- `docs/lld/managed-images.md`
- `docs/lld/validation-scoring-and-judging.md`
- `docs/lld/cost-and-artifacts.md`
- `docs/lld/output-providers.md`
- `docs/lld/mock-mcps-and-clis.md`
- `docs/lld/result-visualization.md`

## Agent-First Onboarding

1. Inspect the project package manager, language, test commands, Docker usage, existing CI, and existing coding-agent configuration.
2. If the active coding agent is unclear, ask which agent is being used.
3. Ask which additional agents should be evaluated.
4. Map selected agents to built-in adapters when possible; create project adapters only when the user asks for unsupported agents.
5. Ask what first evaluation test case the user wants to create.
6. Create or update `harness-evals.yaml` with minimal config: `tests` discovery, selected `agents`, default file output, visualization defaults, judge defaults only when judge assertions are used, and scoring defaults.
7. Leave `docker.image` unset unless the user already has a ready image.
8. Create test cases under `evals/tests/` and mock fixtures under `evals/mocks/` only when needed.
9. Run `harness-evals list` and a focused first `harness-evals run --case <id> --agents <agent>` validation.
10. Report created files, selected agents, test cases, and next commands.

## Safety Rules

- Ask one focused question at a time when required inputs are missing.
- Ask before adding dependencies, creating test cases, configuring additional agents, or overwriting harness files.
- Never write API keys, tokens, passwords, or secret values into repo files.
- Use environment variable names for credentials, for example `OPENAI_API_KEY` or `PI_EVAL_API_KEY`.
- Do not expose managed-image base image or tag-prefix settings.
- Do not configure pricing tables.
- Read existing harness files before editing and merge with user approval.
