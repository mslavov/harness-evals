import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareCurrentAuth } from './current-auth.js';
import { type AgentAdapter, type AgentEventInput, type AgentStepPrepareInput, type AgentStepRunPlan } from './types.js';

export const CURSOR_AUTH_ENV_NAMES = ['CURSOR_API_KEY'] as const;

export const cursorAdapter: AgentAdapter = {
  name: 'cursor',
  authEnvNames: CURSOR_AUTH_ENV_NAMES,
  getInstallRecipe(input) {
    return Promise.resolve({
      basePackages: ['ca-certificates', 'curl'],
      commands: ['curl https://cursor.com/install -fsS | bash && ln -sf "$HOME/.local/bin/agent" /usr/local/bin/cursor-agent'],
      probes: [{ command: [input.agent.command ?? 'cursor-agent', '--version'] }],
      cacheKey: 'cursor-cli',
    });
  },
  async prepareStep(input: AgentStepPrepareInput): Promise<AgentStepRunPlan> {
    const argv = [input.agent.command ?? 'cursor-agent', '--print'];
    if (input.agent.model) argv.push('--model', input.agent.model);
    if (input.agent.outputFormat) argv.push('--output-format', input.agent.outputFormat);
    argv.push(...(input.agent.args ?? []), input.prompt);

    const currentAuth = await prepareCurrentAuth(input, {
      adapterConfigName: 'cursor',
      configEnvName: 'CURSOR_CONFIG_DIR',
      defaultConfigDirs: cursorDefaultConfigDirs(),
      credentialEnvNames: CURSOR_AUTH_ENV_NAMES,
      excludeDirs: ['logs', 'cache', 'Cache', 'chats', 'sessions'],
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

function cursorDefaultConfigDirs(): string[] {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  return xdgConfigHome ? [join(xdgConfigHome, 'cursor'), join(homedir(), '.cursor')] : [join(homedir(), '.cursor')];
}

function planEnvNames(input: AgentStepPrepareInput, authEnvNames: string[], envValues: Record<string, string> | undefined): string[] {
  const envValueNames = new Set(Object.keys(envValues ?? {}));
  return unique([...authEnvNames, ...(input.agent.envAllowlist ?? []), ...(input.agent.env ?? [])]).filter((name) => !envValueNames.has(name));
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
