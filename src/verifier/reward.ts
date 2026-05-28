import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { TestCaseVerifierConfig, VerifierRewardFormat } from '../config/schema.js';
import type { VerifierRewardResult } from './types.js';

export async function readVerifierReward(workspaceDir: string, verifier: TestCaseVerifierConfig): Promise<VerifierRewardResult | undefined> {
  if (!verifier.rewardFile) return undefined;

  const path = join(workspaceDir, verifier.rewardFile);
  const raw = await readFile(path, 'utf8');
  const format = resolveRewardFormat(verifier.rewardFile, verifier.rewardFormat);
  const values = format === 'json' ? parseJsonReward(raw, verifier.rewardFile) : parseTextReward(raw, verifier.rewardFile);
  const numericValues = Object.values(values);
  const primary = typeof values.reward === 'number'
    ? values.reward
    : numericValues.length === 1
      ? numericValues[0]
      : numericValues.length > 0
        ? numericValues.reduce((total, value) => total + value, 0) / numericValues.length
        : undefined;

  return {
    path: verifier.rewardFile,
    format,
    values,
    primary,
    binary: numericValues.length === 1 && (numericValues[0] === 0 || numericValues[0] === 1),
  };
}

function resolveRewardFormat(path: string, configured: VerifierRewardFormat | undefined): 'json' | 'text' {
  if (configured === 'json' || configured === 'text') return configured;
  return extname(path).toLowerCase() === '.json' ? 'json' : 'text';
}

function parseTextReward(raw: string, path: string): Record<string, number> {
  const reward = Number(raw.trim());
  if (!Number.isFinite(reward)) throw new Error(`${path} must contain a numeric reward`);
  return { reward };
}

function parseJsonReward(raw: string, path: string): Record<string, number> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed === 'number' && Number.isFinite(parsed)) return { reward: parsed };
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object with numeric rewards`);

  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path}.${key} must be a numeric reward`);
    values[key] = value;
  }
  if (Object.keys(values).length === 0) throw new Error(`${path} must contain at least one numeric reward`);
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
