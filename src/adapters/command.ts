import { type AgentAdapter, type AgentEventInput, type AgentStepPrepareInput, type AgentStepRunPlan } from './types.js';

export const commandAdapter: AgentAdapter = {
  name: 'command',
  async prepareStep(input: AgentStepPrepareInput): Promise<AgentStepRunPlan> {
    if (!input.agent.command) throw new Error(`Agent ${input.agentName} requires command`);
    const args = renderArgs(input.agent.args ?? [], input.prompt);
    const argv = [input.agent.command, ...args];
    if (!args.some((arg) => arg.includes(input.prompt))) argv.push(input.prompt);

    return {
      argv,
      cwd: input.agent.cwd ?? input.workspace.containerPath,
      envNames: unique([input.agent.apiKeyEnv, ...(input.agent.envAllowlist ?? []), ...(input.agent.env ?? [])]),
      configMounts: [],
      parser: input.agent.parser ?? 'text',
      timeoutMs: input.agent.timeoutMs,
    };
  },
  async parseEvents(input: AgentEventInput) {
    return {
      finalOutput: input.stdout.trim(),
      toolCalls: [],
      errors: input.stderr.trim() ? [input.stderr.trim()] : [],
    };
  },
};

function renderArgs(args: readonly string[], prompt: string): string[] {
  return args.map((arg) => arg.replace(/\{\{\s*prompt\s*}}/g, prompt));
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
