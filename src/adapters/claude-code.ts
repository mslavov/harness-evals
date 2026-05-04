import { defineAdapter, type AgentAdapter, type AgentEventInput, type AgentPrepareInput, type AgentRunPlan } from './types.js';

export const claudeCodeAdapter: AgentAdapter = defineAdapter({
  name: 'claude-code',
  async prepareRun(input: AgentPrepareInput): Promise<AgentRunPlan> {
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
});

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
