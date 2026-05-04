import type { JudgeInputRef } from '../config/schema.js';

export interface JudgeRequest {
  assertionId?: string;
  provider: string;
  model: string;
  apiKeyEnv: string;
  temperature?: number;
  rubric: string;
  threshold: number;
  inputs: Partial<Record<JudgeInputRef, unknown>>;
  prompt: string;
}

export interface JudgeResult {
  score: number;
  pass?: boolean;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface JudgeRecord {
  id?: string;
  assertionId?: string;
  type: 'llmJudge';
  provider?: string;
  model?: string;
  threshold: number;
  score?: number;
  pass: boolean;
  reason: string;
  prompt?: string;
  inputs?: Partial<Record<JudgeInputRef, unknown>>;
  metadata?: Record<string, unknown>;
  error?: string;
}

export type JudgeRunner = (request: JudgeRequest) => Promise<JudgeResult>;
