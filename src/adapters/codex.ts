import { type AgentAdapter, type AgentEventInput, type AgentStepPrepareInput, type AgentStepRunPlan } from './types.js';

export const codexAdapter: AgentAdapter = {
  name: 'codex',
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

    return {
      argv,
      cwd: input.agent.cwd ?? input.workspace.containerPath,
      envNames: unique([...(input.agent.envAllowlist ?? []), ...(input.agent.env ?? [])]),
      configMounts: [],
      parser: input.agent.parser ?? 'text',
      timeoutMs: input.agent.timeoutMs,
    };
  },
  async parseEvents(input: AgentEventInput) {
    return { finalOutput: input.stdout.trim(), toolCalls: [], errors: input.stderr.trim() ? [input.stderr.trim()] : [] };
  },
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
