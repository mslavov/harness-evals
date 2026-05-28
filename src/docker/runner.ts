import { spawn, spawnSync } from 'node:child_process';
import type { ConfigMount } from '../adapters/types.js';
import type { NetworkPolicyConfig } from '../config/schema.js';
import { buildDockerArgs } from './args.js';

export interface DockerRunOptions {
  image: string;
  workspaceDir: string;
  workspaceTarget: string;
  configDir: string;
  configTarget: string;
  home: string;
  argv: string[];
  workdir: string;
  envNames: string[];
  envValues?: Record<string, string>;
  network?: NetworkPolicyConfig;
  configMounts: ConfigMount[];
  caseId: string;
  agentName: string;
  timeoutMs: number;
}

export interface DockerCommandMetadata {
  command: string[];
  image: string;
  containerName: string;
  argv: string[];
  env: Record<string, string | null>;
  mounts: {
    workspace: { source: string; target: string; readonly: boolean };
    config: { source: string; target: string; readonly: boolean };
    extra: ConfigMount[];
  };
  timeoutMs: number;
  network?: NetworkPolicyConfig;
}

export interface DockerRunResult {
  image: string;
  command: string[];
  argv: string[];
  commandMetadata: DockerCommandMetadata;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  errorMessage?: string;
}

export async function runInDocker(options: DockerRunOptions): Promise<DockerRunResult> {
  const containerName = buildContainerName(options.caseId, options.agentName);
  const envValues = withNetworkEnv(options.envValues, options.network);
  const dockerArgs = buildDockerArgs({
    image: options.image,
    containerName,
    workdir: options.workdir,
    home: options.home,
    workspaceMount: { source: options.workspaceDir, target: options.workspaceTarget, readonly: false },
    configMount: { source: options.configDir, target: options.configTarget, readonly: false },
    configMounts: options.configMounts,
    envNames: options.envNames,
    envValues,
    network: options.network,
    argv: options.argv,
  });
  const command = ['docker', ...dockerArgs];
  const commandMetadata: DockerCommandMetadata = {
    command,
    image: options.image,
    containerName,
    argv: options.argv,
    env: {
      ...(envValues ?? {}),
      ...Object.fromEntries(options.envNames.map((name) => [name, process.env[name] ?? null])),
    },
    mounts: {
      workspace: { source: options.workspaceDir, target: options.workspaceTarget, readonly: false },
      config: { source: options.configDir, target: options.configTarget, readonly: false },
      extra: options.configMounts,
    },
    timeoutMs: options.timeoutMs,
    network: options.network,
  };

  const startedAt = Date.now();
  const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let timedOut = false;

  child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
  }, options.timeoutMs);

  const { exitCode, spawnError } = await waitForChild(child);
  clearTimeout(timeout);

  let stdout = Buffer.concat(stdoutChunks).toString('utf8');
  let stderr = Buffer.concat(stderrChunks).toString('utf8');
  let errorMessage: string | undefined;

  if (spawnError) {
    errorMessage = spawnError.message;
    stderr += `${stderr ? '\n' : ''}${spawnError.message}\n`;
  }

  if (timedOut) {
    errorMessage = `Timed out after ${options.timeoutMs}ms`;
    stderr += `${stderr ? '\n' : ''}${errorMessage}\n`;
  }

  return {
    image: options.image,
    command,
    argv: options.argv,
    commandMetadata,
    stdout,
    stderr,
    exitCode,
    durationMs: Date.now() - startedAt,
    timedOut,
    errorMessage,
  };
}

function withNetworkEnv(envValues: Record<string, string> | undefined, network: NetworkPolicyConfig | undefined): Record<string, string> | undefined {
  if (network?.mode !== 'allowlist') return envValues;
  return {
    ...(envValues ?? {}),
    HARNESS_EVALS_NETWORK_ALLOWLIST: (network.allow ?? []).join(','),
  };
}

function buildContainerName(caseId: string, agentName: string): string {
  const safeCaseId = sanitizePathPart(caseId);
  const safeAgentName = sanitizePathPart(agentName);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `harness-eval-${safeCaseId}-${safeAgentName}-${suffix}`.slice(0, 63);
}

function sanitizePathPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'case';
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<{ exitCode: number | null; spawnError?: Error }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: { exitCode: number | null; spawnError?: Error }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.on('error', (error) => settle({ exitCode: null, spawnError: error }));
    child.on('close', (code) => settle({ exitCode: code }));
  });
}
