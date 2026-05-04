import type { AssertionResult } from '../assertions/types.js';
import type { CostReport } from '../events/types.js';
import { mergeCostReports, totalCostForScoring, totalTokensForScoring } from '../cost/rollup.js';
import type { MetricScoreConfig, ProjectScoringConfig, ScoreTarget, ScoreType } from '../config/schema.js';
import type { ScoreBucketResult, ScoreSummary } from './types.js';

interface ScoreAggregationInput {
  assertions: AssertionResult[];
  durationMs?: number;
  cost?: CostReport;
}

interface ScenarioScoreStep {
  status: string;
  durationMs: number;
  assertions: AssertionResult[];
  events: { cost?: CostReport };
}

const METRIC_DEFAULTS: Record<'latency' | 'cost' | 'tokenUsage', Required<Pick<MetricScoreConfig, 'target' | 'best' | 'worst'>>> = {
  latency: { target: 'minimize', best: 0, worst: 600_000 },
  cost: { target: 'minimize', best: 0, worst: 1 },
  tokenUsage: { target: 'minimize', best: 0, worst: 200_000 },
};

export function buildScoreSummary(scoring: ProjectScoringConfig, input: ScoreAggregationInput): ScoreSummary {
  const buckets = [
    assertionPassRateBucket(scoring, input.assertions),
    judgeScoreBucket(scoring, input.assertions),
    metricBucket(scoring, 'latency', input.durationMs),
    metricBucket(scoring, 'cost', totalCost(input.cost, input.assertions)),
    metricBucket(scoring, 'tokenUsage', totalTokens(input.cost, input.assertions)),
  ].filter((bucket): bucket is ScoreBucketResult => Boolean(bucket));

  const weighted = buckets.filter((bucket) => bucket.sourceCount > 0 && bucket.weight > 0);
  const denominator = weighted.reduce((total, bucket) => total + bucket.weight, 0);
  const score = denominator > 0
    ? weighted.reduce((total, bucket) => total + bucket.score * bucket.weight, 0) / denominator
    : 0;

  return {
    score: roundScore(score),
    maxScore: 1,
    buckets,
  };
}

export function buildScenarioScoreSummary(scoring: ProjectScoringConfig, steps: ScenarioScoreStep[]): ScoreSummary {
  const executed = steps.filter((step) => step.status !== 'skipped');
  return buildScoreSummary(scoring, {
    assertions: executed.flatMap((step) => step.assertions),
    durationMs: executed.length > 0 ? executed.reduce((total, step) => total + step.durationMs, 0) : undefined,
    cost: mergeCostReports(executed.map((step) => step.events.cost)),
  });
}

function assertionPassRateBucket(scoring: ProjectScoringConfig, assertions: AssertionResult[]): ScoreBucketResult | undefined {
  const nonJudge = assertions.filter((assertion) => assertion.type !== 'llmJudge');
  if (nonJudge.length === 0) return undefined;
  const passed = nonJudge.filter((assertion) => assertion.pass).length;
  return {
    type: 'assertionPassRate',
    score: roundScore(passed / nonJudge.length),
    weight: weightFor(scoring, 'assertionPassRate'),
    sourceCount: nonJudge.length,
    reason: `${passed}/${nonJudge.length} non-judge assertions passed`,
    metadata: { passed, total: nonJudge.length },
  };
}

function judgeScoreBucket(scoring: ProjectScoringConfig, assertions: AssertionResult[]): ScoreBucketResult | undefined {
  const judgeScores = assertions
    .filter((assertion) => assertion.type === 'llmJudge' && typeof assertion.score === 'number' && Number.isFinite(assertion.score))
    .map((assertion) => assertion.score as number);
  if (judgeScores.length === 0) return undefined;
  const average = judgeScores.reduce((total, score) => total + score, 0) / judgeScores.length;
  return {
    type: 'judgeScore',
    score: roundScore(average),
    weight: weightFor(scoring, 'judgeScore'),
    sourceCount: judgeScores.length,
    reason: `Average judge score ${roundScore(average)}`,
    metadata: { scores: judgeScores },
  };
}

function metricBucket(scoring: ProjectScoringConfig, type: 'latency' | 'cost' | 'tokenUsage', value: number | undefined): ScoreBucketResult | undefined {
  if (value === undefined) return undefined;
  const config = metricConfig(scoring, type);
  const score = normalizeMetric(value, config);
  return {
    type,
    score,
    weight: weightFor(scoring, type),
    sourceCount: 1,
    reason: `${type} metric normalized to ${score}`,
    metadata: {
      value,
      target: config.target,
      best: config.best,
      worst: config.worst,
    },
  };
}

function weightFor(scoring: ProjectScoringConfig, type: ScoreType): number {
  const weight = scoring[type]?.weight;
  return typeof weight === 'number' && Number.isFinite(weight) ? weight : 0;
}

function metricConfig(scoring: ProjectScoringConfig, type: 'latency' | 'cost' | 'tokenUsage'): Required<Pick<MetricScoreConfig, 'target' | 'best' | 'worst'>> {
  const raw = scoring[type] as MetricScoreConfig | undefined;
  const defaults = METRIC_DEFAULTS[type];
  return {
    target: isScoreTarget(raw?.target) ? raw.target : defaults.target,
    best: numberOr(raw?.best, defaults.best),
    worst: numberOr(raw?.worst, defaults.worst),
  };
}

function normalizeMetric(value: number, config: Required<Pick<MetricScoreConfig, 'target' | 'best' | 'worst'>>): number {
  const denominator = config.target === 'minimize'
    ? config.worst - config.best
    : config.best - config.worst;
  if (denominator === 0) return value === config.best ? 1 : 0;
  const normalized = config.target === 'minimize'
    ? (config.worst - value) / denominator
    : (value - config.worst) / denominator;
  return roundScore(clamp(normalized));
}

function totalCost(cost: CostReport | undefined, assertions: AssertionResult[]): number | undefined {
  return totalCostForScoring(cost) ?? sumDefined([
    ...assertions.map((assertion) => readNestedNumber(assertion.metadata, ['usage', 'totalCost'])),
    ...assertions.map((assertion) => readNestedNumber(assertion.metadata, ['cost', 'totalCost'])),
  ]);
}

function totalTokens(cost: CostReport | undefined, assertions: AssertionResult[]): number | undefined {
  return totalTokensForScoring(cost) ?? sumDefined([
    ...assertions.map((assertion) => readNestedNumber(assertion.metadata, ['usage', 'totalTokens'])),
  ]);
}

function readNestedNumber(value: unknown, path: string[]): number | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return numberOrUndefined(current);
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isScoreTarget(value: unknown): value is ScoreTarget {
  return value === 'maximize' || value === 'minimize';
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
