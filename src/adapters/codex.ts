import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareCurrentAuth } from './current-auth.js';
import { type AgentAdapter, type AgentEventInput, type AgentStepPrepareInput, type AgentStepRunPlan } from './types.js';

export const CODEX_AUTH_ENV_NAMES = ['OPENAI_API_KEY'] as const;

export const codexAdapter: AgentAdapter = {
  name: 'codex',
  authEnvNames: CODEX_AUTH_ENV_NAMES,
  getInstallRecipe(input) {
    return Promise.resolve({
      commands: ['npm install -g @openai/codex'],
      probes: [{ command: [input.agent.command ?? 'codex', '--version'] }],
      cacheKey: '@openai/codex',
    });
  },
  async prepareStep(input: AgentStepPrepareInput): Promise<AgentStepRunPlan> {
    const extraArgs = input.agent.args ?? [];
    const argv = [input.agent.command ?? 'codex', 'exec'];
    if (input.agent.model) argv.push('--model', input.agent.model);
    if (input.agent.profile) argv.push('--profile', input.agent.profile);
    argv.push(...execSandboxArgs(input, extraArgs), ...extraArgs, input.prompt);

    const currentAuth = await prepareCurrentAuth(input, {
      adapterConfigName: 'codex',
      configEnvName: 'CODEX_HOME',
      defaultConfigDirs: [join(homedir(), '.codex')],
      credentialEnvNames: CODEX_AUTH_ENV_NAMES,
      secretFiles: ['auth.json'],
      excludeDirs: ['sessions', 'log', 'history.jsonl', 'tmp'],
    });

    return {
      argv,
      cwd: input.agent.cwd ?? input.workspace.containerPath,
      envNames: planEnvNames(input, currentAuth.envNames, currentAuth.envValues),
      envValues: currentAuth.envValues,
      configMounts: currentAuth.configMounts,
      parser: input.agent.parser ?? 'text',
      timeoutMs: input.agent.timeoutMs,
      cleanupPaths: currentAuth.cleanupPaths,
      metadata: { currentAuth: currentAuth.metadata },
    };
  },
  async parseEvents(input: AgentEventInput) {
    return { finalOutput: input.stdout.trim(), toolCalls: [], errors: input.stderr.trim() ? [input.stderr.trim()] : [] };
  },
};

// `codex exec` defaults to a read-only sandbox and would fail to edit the workspace. Since runs are
// already containerized, default to a writable, network-enabled sandbox and skip the git-repo check.
// Both are overridable: pass `--sandbox`/`-s`/`--dangerously-bypass-approvals-and-sandbox` in
// `agent.args` to control the sandbox, or set `config.codexSandbox` / `config.skipGitRepoCheck`.
function execSandboxArgs(input: AgentStepPrepareInput, extraArgs: readonly string[]): string[] {
  const config = input.agent.config ?? {};
  const args: string[] = [];

  const sandboxControlled =
    extraArgs.includes('--sandbox') ||
    extraArgs.includes('-s') ||
    extraArgs.includes('--dangerously-bypass-approvals-and-sandbox');
  if (!sandboxControlled) {
    const mode = readString(config.codexSandbox) ?? 'danger-full-access';
    args.push('--sandbox', mode);
  }

  const skipGitRepoCheck = readBoolean(config.skipGitRepoCheck) ?? true;
  if (skipGitRepoCheck && !extraArgs.includes('--skip-git-repo-check')) {
    args.push('--skip-git-repo-check');
  }

  return args;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function planEnvNames(input: AgentStepPrepareInput, authEnvNames: string[], envValues: Record<string, string> | undefined): string[] {
  const envValueNames = new Set(Object.keys(envValues ?? {}));
  return unique([...authEnvNames, ...(input.agent.envAllowlist ?? []), ...(input.agent.env ?? [])]).filter((name) => !envValueNames.has(name));
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
