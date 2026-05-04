# LLD — Agent-First Install and Configuration

> **HLD:** `../HDL.md`
> **Companion LLDs:** `scenario-runner.md`, `adapter-registry-and-contract.md`, `managed-images.md`, `validation-scoring-and-judging.md`, `cost-and-artifacts.md`, `output-providers.md`, `mock-mcps-and-clis.md`, `result-visualization.md`
> **Status:** Draft

## How this fits

This LLD defines the agent-first onboarding path. The framework ships an installable agent skill that guides a coding agent through project discovery, framework installation, harness configuration, adapter selection, and first test-case setup.

## 1. Domain Overview

The primary onboarding path is a skill installed with the Skills CLI. A user installs the skill into one or more coding agents, activates it with `/harness-evals`, and lets the active agent configure the project from the design docs owned by the skill.

The skill does not replace the CLI or runtime. It is the agent-facing setup guide for creating and maintaining `harness-evals.yaml`, test case files under `evals/tests/` by default, mock fixtures under `evals/mocks/`, adapter declarations, output provider config, visualization config, judge config, and project scoring config.

## 2. Distribution Layout

The skill source contains the skill instructions and the design docs used as the agent reference:

```text
skills/harness-evals/
  SKILL.md
  docs/
    HDL.md
    lld/
      agent-first-install-and-config.md
      scenario-runner.md
      adapter-registry-and-contract.md
      managed-images.md
      validation-scoring-and-judging.md
      cost-and-artifacts.md
      output-providers.md
      mock-mcps-and-clis.md
      result-visualization.md
```

`SKILL.md` contains an index pointing to the skill docs:

```markdown
---
name: harness-evals
description: Install, configure, and extend harness-evals for coding-agent evaluation projects.
---

# Harness Evals

Use this skill when the user asks to install, configure, extend, or create tests for harness-evals.

## Reference Docs

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
```

## 3. Install and Activation Flow

The skill is installed with the Skills CLI:

```bash
npx skills add <package-source> --skill harness-evals
```

Users can target specific agents:

```bash
npx skills add <package-source> --skill harness-evals --agent pi --agent claude-code --agent codex --agent cursor
```

After installation, the user activates the skill with:

```text
/harness-evals
```

Agents that do not support slash-style activation still load the skill by name or by matching the skill description.

## 4. Agent Workflow

When activated, the skill instructs the agent to:

1. Read `docs/HDL.md` and the LLDs relevant to the requested task.
2. Inspect the project package manager, language, test commands, Docker usage, existing CI, and existing agent configuration.
3. Identify the active coding agent and ask which additional agents should be evaluated.
4. Map selected agents to built-in adapters or declare custom adapters when needed.
5. Ask what evaluation test cases the user wants to create.
6. Create or update `harness-evals.yaml`.
7. Create test case files under `evals/tests/`, mock fixtures under `evals/mocks/`, and fixtures when needed.
8. Configure top-level `judge`, project-level `scoring`, output providers, and visualization when requested.
9. Run validation commands and the first harness evaluation.
10. Report the created files, selected agents, test cases, and how to run the next eval.

The skill uses the docs as the source of truth and edits project files only after collecting the required project-specific inputs.

## 5. Generated Project Shape

A configured project uses this shape:

```text
harness-evals.yaml
evals/
  tests/
    <test-case-id>.yaml
  mocks/
    cli/
      <mock-fixture>.yaml
    mcp/
      <mock-fixture>.yaml
  fixtures/
    <fixture-name>/
```

The skill may also create project-defined adapters or output providers when the user asks for extension points:

```text
evals/
  adapters/
    <adapter-name>.ts
  output/
    <provider-name>.ts
```

## 6. Configuration Responsibilities

| Concern | Skill responsibility |
| --- | --- |
| Framework install | Detect package manager and add the harness package. |
| Active agent | Detect or ask which agent is currently being used. |
| Additional agents | Ask which agents should be evaluated and create `agents` entries. |
| Adapter selection | Prefer built-in adapters; declare project adapters for custom agents. |
| Managed images | Leave managed-image internals unset; configure `docker.image` only when the user has a ready image. |
| Test cases | Keep assertions on individual test cases and steps; use `evals/tests/**/*.yaml` by default and configure `tests` only to override discovery. |
| Judge | Configure top-level `judge` when LLM-as-judge assertions are used. |
| Scoring | Configure project-level `scoring` score types and weights. |
| Mocks | Create CLI/MCP mock fixtures when test cases need deterministic external integrations. |
| Outputs | Default to file output unless the user selects additional providers. |
| Visualization | Keep visualization defaults unless the user wants specific formats or report behavior. |
| Verification | Run the project checks and a minimal harness eval when configured. |

## 7. Safety Rules

- The skill asks before adding dependencies, creating test cases, or configuring additional agents.
- The skill does not write secrets into repo files.
- The skill uses env var names for API keys and agent credentials.
- The skill does not expose managed-image base image or tag-prefix settings.
- The skill does not configure pricing tables.
- The skill does not overwrite existing harness files without reading them first.

## 8. Failure Modes

| Failure mode | Symptom | Detection | Remediation |
| --- | --- | --- | --- |
| Skill not installed for active agent | `/harness-evals` is unavailable | Agent cannot find skill | Install with `npx skills add` for the active agent |
| Project type unclear | Agent cannot choose install command | Package manager detection fails | Ask the user which package manager to use |
| Active agent unclear | Agent cannot create an accurate default `agents` entry | Agent detection fails | Ask the user which coding agent is being used |
| Missing credentials | First eval cannot run selected agent or judge | Env var lookup fails | Ask for env var names, not secret values |
| Existing harness config present | Setup may overwrite user choices | `harness-evals.yaml` exists | Read and merge config with user approval |
| Unsupported agent selected | No built-in adapter exists | Adapter registry lookup fails | Create a project adapter or remove the agent from the eval matrix |

## 9. Target Skill Behavior

The skill is concise and task-oriented:

- Read the bundled docs before configuring the project.
- Ask one focused question at a time when required inputs are missing.
- Prefer defaults that produce a working first eval.
- Keep generated config minimal.
- Explain how to run `harness-evals run` after setup.
