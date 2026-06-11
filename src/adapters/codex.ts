import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CostReport, UsageReport } from '../events/types.js';
import { prepareCurrentAuth } from './current-auth.js';
import { stdoutLines } from './stdout-lines.js';
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
    const command = input.agent.command ?? 'codex';
    const argv = [command, 'exec'];
    if (input.agent.model) argv.push('--model', input.agent.model);
    if (input.agent.profile) argv.push('--profile', input.agent.profile);
    // Default to JSONL events (`--json`) so parseEvents can extract the final message and token
    // usage; set `outputFormat: text` to opt out. Only the real CLI gets the default — substitute
    // `command:` binaries may not accept it.
    const outputFormat = input.agent.outputFormat ?? (command === 'codex' ? 'json' : undefined);
    if (outputFormat === 'json' && !extraArgs.includes('--json')) argv.push('--json');
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
    const errors = input.stderr.trim() ? [input.stderr.trim()] : [];
    if (!input.plan?.argv?.includes('--json')) {
      return { finalOutput: input.stdout.trim(), toolCalls: [], errors };
    }
    return parseCodexJsonEvents(input, errors);
  },
};

// `codex exec --json` emits JSONL. Shapes are tolerated across CLI versions:
// final message from `item.completed` items of type `agent_message` (or legacy
// `msg.type === "agent_message"`), usage from `turn.completed` events (summed) with a
// fallback to the last cumulative `token_count` message.
async function parseCodexJsonEvents(input: AgentEventInput, errors: string[]) {
  let finalOutput = '';
  let turnInput = 0;
  let turnCached = 0;
  let turnOutput = 0;
  let sawTurnUsage = false;
  let cumulative: Record<string, unknown> | undefined;

  for await (const line of stdoutLines(input)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) continue;
      event = parsed;
    } catch {
      continue;
    }
    const item = isRecord(event.item) ? event.item : undefined;
    if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      finalOutput = item.text;
    }
    const msg = isRecord(event.msg) ? event.msg : undefined;
    if (msg?.type === 'agent_message' && typeof msg.message === 'string') finalOutput = msg.message;
    if (event.type === 'turn.completed' && isRecord(event.usage)) {
      sawTurnUsage = true;
      turnInput += numberOrZero(event.usage.input_tokens);
      turnCached += numberOrZero(event.usage.cached_input_tokens);
      turnOutput += numberOrZero(event.usage.output_tokens);
    }
    if (msg?.type === 'token_count') {
      const info = isRecord(msg.info) ? msg.info : msg;
      const total = isRecord(info.total_token_usage) ? info.total_token_usage : info;
      if (isRecord(total)) cumulative = total;
    }
    if (event.type === 'error' && typeof event.message === 'string') errors.push(event.message);
    if (msg?.type === 'error' && typeof msg.message === 'string') errors.push(msg.message);
  }

  const usage = codexUsageReport(input, { sawTurnUsage, turnInput, turnCached, turnOutput, cumulative });
  return {
    finalOutput: finalOutput || input.stdout.trim(),
    toolCalls: [],
    errors,
    cost: usage,
  };
}

function codexUsageReport(
  input: AgentEventInput,
  totals: { sawTurnUsage: boolean; turnInput: number; turnCached: number; turnOutput: number; cumulative?: Record<string, unknown> },
): CostReport | undefined {
  let inputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reasoningTokens: number | undefined;
  if (totals.sawTurnUsage) {
    inputTokens = totals.turnInput;
    cachedInputTokens = totals.turnCached;
    outputTokens = totals.turnOutput;
  } else if (totals.cumulative) {
    inputTokens = numberOrUndefined(totals.cumulative.input_tokens);
    cachedInputTokens = numberOrUndefined(totals.cumulative.cached_input_tokens);
    outputTokens = numberOrUndefined(totals.cumulative.output_tokens);
    reasoningTokens = numberOrUndefined(totals.cumulative.reasoning_output_tokens);
  } else {
    return undefined;
  }
  const argv = input.plan?.argv ?? [];
  const modelIndex = argv.indexOf('--model');
  const usage: UsageReport = {
    provider: 'openai',
    model: modelIndex >= 0 ? (argv[modelIndex + 1] ?? 'unknown') : 'unknown',
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    totalTokens: sumDefined([inputTokens, outputTokens]),
  };
  return { available: true, usage: [usage] };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
