import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareCurrentAuth } from './current-auth.js';
import { type AgentAdapter, type AgentEventInput, type AgentStepPrepareInput, type AgentStepRunPlan } from './types.js';

export const CLAUDE_AUTH_ENV_NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

export const claudeCodeAdapter: AgentAdapter = {
  name: 'claude-code',
  authEnvNames: CLAUDE_AUTH_ENV_NAMES,
  getInstallRecipe(input) {
    return Promise.resolve({
      commands: ['npm install -g @anthropic-ai/claude-code'],
      probes: [{ command: [input.agent.command ?? 'claude', '--version'] }],
      cacheKey: '@anthropic-ai/claude-code',
    });
  },
  async prepareStep(input: AgentStepPrepareInput): Promise<AgentStepRunPlan> {
    const argv = [input.agent.command ?? 'claude', '-p', input.prompt];
    if (input.agent.model) argv.push('--model', input.agent.model);
    if (input.agent.outputFormat) argv.push('--output-format', input.agent.outputFormat);
    argv.push(...(input.agent.args ?? []));

    const currentAuth = await prepareCurrentAuth(input, {
      adapterConfigName: 'claude',
      configEnvName: 'CLAUDE_CONFIG_DIR',
      defaultConfigDirs: [join(homedir(), '.claude')],
      credentialEnvNames: CLAUDE_AUTH_ENV_NAMES,
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
