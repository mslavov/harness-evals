import type { JudgeRequest, JudgeResult, JudgeRunner } from './types.js';

type PiAiModule = {
  getModel(provider: string, model: string): unknown;
  complete(model: unknown, context: unknown, options?: Record<string, unknown>): Promise<PiAiAssistantMessage>;
};

type PiAiAssistantMessage = {
  content?: Array<{ type: string; text?: string }>;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
  stopReason?: string;
  errorMessage?: string;
};

export const defaultJudgeRunner: JudgeRunner = async (request) => {
  const apiKey = process.env[request.apiKeyEnv];
  if (!apiKey) throw new Error(`Judge credential env ${request.apiKeyEnv} is not set`);

  const piAi = await importPiAi();
  const model = piAi.getModel(request.provider, request.model);
  const response = await piAi.complete(model, {
    systemPrompt: 'You are a strict evaluation judge. Return only valid JSON.',
    messages: [{ role: 'user', content: request.prompt, timestamp: Date.now() }],
  }, {
    apiKey,
    temperature: request.temperature,
  });

  const rawOutput = extractText(response);
  const parsed = parseJudgeResponse(rawOutput);
  return {
    ...parsed,
    metadata: {
      ...(parsed.metadata ?? {}),
      rawOutput,
      stopReason: response.stopReason,
      usage: normalizeUsage(response, request),
    },
  };
};

async function importPiAi(): Promise<PiAiModule> {
  const specifier: string = '@mariozechner/pi-ai';
  try {
    return await import(specifier) as PiAiModule;
  } catch (error) {
    throw new Error(`Failed to load @mariozechner/pi-ai for llmJudge: ${errorMessage(error)}`);
  }
}

function parseJudgeResponse(text: string): JudgeResult {
  const parsed = JSON.parse(extractJsonObject(text)) as unknown;
  if (!isRecord(parsed)) throw new Error('Judge response must be a JSON object');
  if (typeof parsed.score !== 'number' || !Number.isFinite(parsed.score)) throw new Error('Judge response score must be a number');
  if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) throw new Error('Judge response reason must be a non-empty string');
  if (parsed.pass !== undefined && typeof parsed.pass !== 'boolean') throw new Error('Judge response pass must be a boolean when provided');
  if (parsed.metadata !== undefined && !isRecord(parsed.metadata)) throw new Error('Judge response metadata must be an object when provided');
  return {
    score: parsed.score,
    pass: parsed.pass,
    reason: parsed.reason,
    metadata: parsed.metadata,
  };
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('Judge response did not contain a JSON object');
  return trimmed.slice(start, end + 1);
}

function extractText(response: PiAiAssistantMessage): string {
  return (response.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
}

function normalizeUsage(response: PiAiAssistantMessage, request: JudgeRequest): Record<string, unknown> | undefined {
  const usage = response.usage;
  if (!usage) return undefined;
  const inputTokens = numberOrUndefined(usage.input);
  const outputTokens = numberOrUndefined(usage.output);
  const cachedInputTokens = numberOrUndefined(usage.cacheRead);
  const totalTokens = numberOrUndefined(usage.totalTokens) ?? sumDefined([inputTokens, outputTokens, cachedInputTokens]);
  const totalCost = numberOrUndefined(usage.cost?.total);
  return {
    provider: response.provider ?? request.provider,
    model: response.model ?? request.model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
    totalCost,
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
