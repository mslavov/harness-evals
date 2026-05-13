import type { JudgeResult } from './types.js';

export function parseJudgeResponse(text: string): JudgeResult {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
