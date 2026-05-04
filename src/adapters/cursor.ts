import { type AgentAdapter, type AgentEventInput, type AgentStepPrepareInput, type AgentStepRunPlan } from './types.js';

export const cursorAdapter: AgentAdapter = {
  name: 'cursor',
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
