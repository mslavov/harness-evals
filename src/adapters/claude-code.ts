import { type AgentAdapter, type AgentEventInput, type AgentStepPrepareInput, type AgentStepRunPlan } from './types.js';

export const claudeCodeAdapter: AgentAdapter = {
  name: 'claude-code',
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
