import type { TestCaseVerifierConfig } from '../config/schema.js';
import type { DockerCommandMetadata } from '../docker/runner.js';

export type VerifierStatus = 'passed' | 'failed' | 'timeout' | 'error';

export interface VerifierRewardResult {
  path: string;
  format: 'json' | 'text';
  values: Record<string, number>;
  primary?: number;
  binary: boolean;
}

export interface VerifierRunResult {
  status: VerifierStatus;
  pass: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  command?: DockerCommandMetadata;
  reward?: VerifierRewardResult;
  startedAt: string;
  completedAt: string;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface ModelPatchArtifact {
  path: string;
  bytes: number;
  empty: boolean;
}

export interface HiddenPatchResult {
  path: string;
  applied: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export function shouldCaptureModelPatch(verifier: TestCaseVerifierConfig): boolean {
  return verifier.captureModelPatch === true || Boolean(verifier.hiddenPatch);
}
