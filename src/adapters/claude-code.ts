import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CostReport, UsageReport } from '../events/types.js';
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
    const config = input.agent.config ?? {};
    const command = input.agent.command ?? 'claude';
    const argv = [command, '-p', input.prompt];
    if (input.agent.model) argv.push('--model', input.agent.model);
    // Default to json so parseEvents can report tokens + cost; set `outputFormat: text` to opt
    // out. Only the real CLI gets the default — substitute `command:` binaries may not accept it.
    const outputFormat = input.agent.outputFormat ?? (command === 'claude' ? 'json' : undefined);
    if (outputFormat && outputFormat !== 'text') argv.push('--output-format', outputFormat);
    const mcpConfig = readString(config.mcpConfig);
    if (mcpConfig) argv.push('--mcp-config', mcpConfig);
    if (readBoolean(config.strictMcp) === true) argv.push('--strict-mcp-config');
    argv.push(...(input.agent.args ?? []));

    const currentAuth = await prepareCurrentAuth(input, {
      adapterConfigName: 'claude',
      configEnvName: 'CLAUDE_CONFIG_DIR',
      defaultConfigDirs: [join(homedir(), '.claude')],
      credentialEnvNames: CLAUDE_AUTH_ENV_NAMES,
      secretFiles: ['.credentials.json'],
      excludeDirs: ['projects', 'todos', 'statsig', 'shell-snapshots', 'logs', 'history'],
      siblingFiles: [{ sourcePath: join(homedir(), '.claude.json'), targetName: '.claude.json' }],
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
    const errors = input.stderr.trim() ? [input.stderr.trim()] : [];
    const result = findClaudeResultObject(input);
    if (result) {
      if (result.is_error === true) {
        errors.push(typeof result.result === 'string' ? result.result : `claude reported ${String(result.subtype ?? 'error')}`);
      }
      return {
        finalOutput: typeof result.result === 'string' ? result.result : input.stdout.trim(),
        toolCalls: [],
        errors,
        cost: claudeCostReport(result),
      };
    }
    return { finalOutput: input.stdout.trim(), toolCalls: [], errors };
  },
};

// With `--output-format json` claude prints one result object; with `stream-json` it prints JSONL
// whose last `type: "result"` event carries the same fields (result, usage, modelUsage, total_cost_usd).
function findClaudeResultObject(input: AgentEventInput): Record<string, unknown> | undefined {
  const format = argvValue(input.plan?.argv, '--output-format');
  if (format !== 'json' && format !== 'stream-json') return undefined;
  const lines = input.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index] as string) as unknown;
      if (isRecord(parsed) && parsed.type === 'result') return parsed;
    } catch {
      // `json` format pretty-prints across lines; fall through to whole-stdout parse.
      break;
    }
  }
  try {
    const parsed = JSON.parse(input.stdout) as unknown;
    if (isRecord(parsed) && parsed.type === 'result') return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

function claudeCostReport(result: Record<string, unknown>): CostReport | undefined {
  const usage: UsageReport[] = [];
  const modelUsage = isRecord(result.modelUsage) ? result.modelUsage : undefined;
  if (modelUsage) {
    for (const [model, value] of Object.entries(modelUsage)) {
      if (!isRecord(value)) continue;
      const inputTokens = numberOrUndefined(value.inputTokens);
      const outputTokens = numberOrUndefined(value.outputTokens);
      const cachedInputTokens = numberOrUndefined(value.cacheReadInputTokens);
      const cacheCreationInputTokens = numberOrUndefined(value.cacheCreationInputTokens);
      usage.push({
        provider: 'anthropic',
        model,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens: sumDefined([inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens]),
        totalCost: numberOrUndefined(value.costUSD),
        currency: 'USD',
        metadata: cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : undefined,
      });
    }
  }
  const topUsage = isRecord(result.usage) ? result.usage : undefined;
  if (usage.length === 0 && topUsage) {
    const inputTokens = numberOrUndefined(topUsage.input_tokens);
    const outputTokens = numberOrUndefined(topUsage.output_tokens);
    const cachedInputTokens = numberOrUndefined(topUsage.cache_read_input_tokens);
    const cacheCreationInputTokens = numberOrUndefined(topUsage.cache_creation_input_tokens);
    usage.push({
      provider: 'anthropic',
      model: 'unknown',
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens: sumDefined([inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens]),
      totalCost: numberOrUndefined(result.total_cost_usd),
      currency: 'USD',
      metadata: cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : undefined,
    });
  }
  const totalCost = numberOrUndefined(result.total_cost_usd);
  if (usage.length === 0 && totalCost === undefined) return undefined;
  return {
    available: true,
    currency: 'USD',
    totalCost,
    usage: usage.length > 0 ? usage : undefined,
  };
}

function argvValue(argv: readonly string[] | undefined, flag: string): string | undefined {
  if (!argv) return undefined;
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? defined.reduce((total, value) => total + value, 0) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function planEnvNames(input: AgentStepPrepareInput, authEnvNames: string[], envValues: Record<string, string> | undefined): string[] {
  const envValueNames = new Set(Object.keys(envValues ?? {}));
  return unique([...authEnvNames, ...(input.agent.envAllowlist ?? []), ...(input.agent.env ?? [])]).filter((name) => !envValueNames.has(name));
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
