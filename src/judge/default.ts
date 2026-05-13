import { parseJudgeResponse } from './parse.js';
import type { JudgeRequest, JudgeRunner } from './types.js';

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
  if (!request.provider) throw new Error('llmJudge requires judge.provider or an adapter-backed judge');
  if (!request.model) throw new Error('llmJudge requires judge.model or an adapter-backed judge');
  if (!request.apiKeyEnv) throw new Error('llmJudge requires judge.apiKeyEnv or an adapter-backed judge');
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
