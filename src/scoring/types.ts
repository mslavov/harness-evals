import type { ScoreType } from '../config/schema.js';

export interface ScoreBucketResult {
  type: ScoreType;
  score: number;
  weight: number;
  sourceCount: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface ScoreSummary {
  score: number;
  maxScore: 1;
  buckets: ScoreBucketResult[];
}
