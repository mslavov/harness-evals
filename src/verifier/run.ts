import { posix as posixPath } from 'node:path';
import type { TestCaseVerifierConfig, WorkspaceConfig, DockerConfig, NetworkPolicyConfig } from '../config/schema.js';
import { runInDocker } from '../docker/runner.js';
import { readVerifierReward } from './reward.js';
import type { VerifierRunResult } from './types.js';

export interface RunVerifierInput {
  verifier: TestCaseVerifierConfig;
  dockerImage: string;
  workspaceDir: string;
  configDir: string;
  workspace: WorkspaceConfig;
  docker: DockerConfig;
  caseId: string;
  agentName: string;
}

export async function runVerifier(input: RunVerifierInput): Promise<VerifierRunResult> {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const argv = [input.verifier.command, ...(input.verifier.args ?? [])];
  const network = verifierNetworkPolicy(input.verifier.network);
  const docker = await runInDocker({
    image: input.dockerImage,
    workspaceDir: input.workspaceDir,
    workspaceTarget: input.workspace.containerPath,
    configDir: input.configDir,
    configTarget: input.docker.configRoot,
    home: input.docker.home,
    argv,
    workdir: verifierWorkdir(input.verifier, input.workspace),
    envNames: input.verifier.env ?? [],
    configMounts: [],
    caseId: input.caseId,
    agentName: `${input.agentName}-verifier`,
    timeoutMs: input.verifier.timeoutMs ?? input.docker.timeoutMs,
    network,
  });

  let reward: VerifierRunResult['reward'];
  let rewardError: string | undefined;
  try {
    reward = await readVerifierReward(input.workspaceDir, input.verifier);
  } catch (error) {
    rewardError = error instanceof Error ? error.message : String(error);
  }

  const error = verifierError(docker.errorMessage, rewardError, docker.exitCode);
  const pass = !docker.timedOut && !docker.errorMessage && !rewardError && docker.exitCode === 0 && verifierRewardPasses(reward);
  const status = docker.timedOut ? 'timeout' : docker.errorMessage || rewardError ? 'error' : pass ? 'passed' : 'failed';

  return {
    status,
    pass,
    exitCode: docker.exitCode,
    durationMs: Date.now() - startedAtMs,
    stdout: docker.stdout,
    stderr: docker.stderr,
    command: docker.commandMetadata,
    reward,
    startedAt,
    completedAt: new Date().toISOString(),
    error,
    metadata: {
      reward,
      network,
      rewardError,
    },
  };
}

export function verifierSetupError(message: string): VerifierRunResult {
  const now = new Date().toISOString();
  return {
    status: 'error',
    pass: false,
    exitCode: null,
    durationMs: 0,
    stdout: '',
    stderr: message,
    startedAt: now,
    completedAt: now,
    error: message,
    metadata: { setupError: message },
  };
}

function verifierWorkdir(verifier: TestCaseVerifierConfig, workspace: WorkspaceConfig): string {
  if (!verifier.cwd) return workspace.containerPath;
  if (verifier.cwd.startsWith('/')) return verifier.cwd;
  return posixPath.join(workspace.containerPath, verifier.cwd);
}

function verifierNetworkPolicy(configured: NetworkPolicyConfig | undefined): NetworkPolicyConfig {
  return configured ?? { mode: 'none' };
}

function verifierRewardPasses(reward: VerifierRunResult['reward']): boolean {
  if (!reward) return true;
  return typeof reward.primary === 'number' && reward.primary > 0;
}

function verifierError(dockerError: string | undefined, rewardError: string | undefined, exitCode: number | null): string | undefined {
  if (dockerError && rewardError) return `${dockerError}; ${rewardError}`;
  if (dockerError) return dockerError;
  if (rewardError) return rewardError;
  if (exitCode !== 0) return `Verifier exited with code ${exitCode}`;
  return undefined;
}
