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
    const argv = [input.agent.command ?? 'codex', 'exec'];
    if (input.agent.model) argv.push('--model', input.agent.model);
    if (input.agent.profile) argv.push('--profile', input.agent.profile);
    argv.push(...(input.agent.args ?? []), input.prompt);

    const currentAuth = await prepareCurrentAuth(input, {
      adapterConfigName: 'codex',
      configEnvName: 'CODEX_HOME',
      defaultConfigDirs: [join(homedir(), '.codex')],
      credentialEnvNames: CODEX_AUTH_ENV_NAMES,
    });

    return {
      argv,
      cwd: input.agent.cwd ?? input.workspace.containerPath,
      envNames: planEnvNames(input, currentAuth.envNames, currentAuth.envValues),
      envValues: currentAuth.envValues,
      configMounts: currentAuth.configMounts,
      parser: input.agent.parser ?? 'text',
      timeoutMs: input.agent.timeoutMs,
      metadata: { currentAuth: currentAuth.metadata },
    };
  },
  async parseEvents(input: AgentEventInput) {
    return { finalOutput: input.stdout.trim(), toolCalls: [], errors: input.stderr.trim() ? [input.stderr.trim()] : [] };
  },
};

function planEnvNames(input: AgentStepPrepareInput, authEnvNames: string[], envValues: Record<string, string> | undefined): string[] {
  const envValueNames = new Set(Object.keys(envValues ?? {}));
  return unique([...authEnvNames, ...(input.agent.envAllowlist ?? []), ...(input.agent.env ?? [])]).filter((name) => !envValueNames.has(name));
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
