import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
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
  /**
   * Stream stdout/stderr to these files as chunks arrive instead of holding the
   * full output in memory. Agent event streams can reach gigabytes (past V8's
   * string limits); with a file sink, the in-memory copy is capped to the tail.
   */
  stdoutFile?: string;
  stderrFile?: string;
  /** Max bytes of each stream retained in memory (tail). Default 16 MiB. */
  maxBufferedBytes?: number;
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
  /** In-memory copy of the stream; only the tail when `stdoutTruncated` is set. */
  stdout: string;
  stderr: string;
  /** Full artifact on disk when the caller passed `stdoutFile` and the write succeeded. */
  stdoutPath?: string;
  stderrPath?: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
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
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const stdoutCapture = captureStream(options.stdoutFile, maxBufferedBytes);
  const stderrCapture = captureStream(options.stderrFile, maxBufferedBytes);
  let timedOut = false;

  child.stdout?.on('data', (chunk: Buffer) => stdoutCapture.onChunk(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderrCapture.onChunk(chunk));

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
  }, options.timeoutMs);

  const { exitCode, spawnError } = await waitForChild(child);
  clearTimeout(timeout);

  const out = await stdoutCapture.finish();
  const err = await stderrCapture.finish();
  const stdout = out.text;
  let stderr = err.text;
  let errorMessage: string | undefined;

  for (const writeError of [out.writeError, err.writeError]) {
    if (!writeError) continue;
    stderr += `${stderr ? '\n' : ''}Failed to stream output to file: ${writeError.message}\n`;
  }

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
    stdoutPath: options.stdoutFile && !out.writeError ? options.stdoutFile : undefined,
    stderrPath: options.stderrFile && !err.writeError ? options.stderrFile : undefined,
    stdoutBytes: out.bytes,
    stderrBytes: err.bytes,
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
    exitCode,
    durationMs: Date.now() - startedAt,
    timedOut,
    errorMessage,
  };
}

const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

interface StreamCapture {
  onChunk(chunk: Buffer): void;
  finish(): Promise<{ text: string; bytes: number; truncated: boolean; writeError?: Error }>;
}

// Keeps the in-memory copy capped to the trailing `maxBytes` (final agent
// messages and result objects live at the end of a stream); the full stream
// goes to `file` when provided.
function captureStream(file: string | undefined, maxBytes: number): StreamCapture {
  const chunks: Buffer[] = [];
  let buffered = 0;
  let bytes = 0;
  let truncated = false;
  let writeError: Error | undefined;
  const sink = file ? createWriteStream(file) : undefined;
  sink?.on('error', (error: Error) => {
    writeError = writeError ?? error;
  });

  return {
    onChunk(chunk: Buffer) {
      bytes += chunk.length;
      if (sink && !writeError) sink.write(chunk);
      chunks.push(chunk);
      buffered += chunk.length;
      while (buffered > maxBytes && chunks.length > 1) {
        const dropped = chunks.shift();
        buffered -= dropped?.length ?? 0;
        truncated = true;
      }
      if (buffered > maxBytes && chunks.length === 1) {
        const only = chunks[0];
        if (only) {
          chunks[0] = only.subarray(only.length - maxBytes);
          buffered = maxBytes;
          truncated = true;
        }
      }
    },
    finish() {
      return new Promise((resolve) => {
        const settle = () => resolve({ text: Buffer.concat(chunks).toString('utf8'), bytes, truncated, writeError });
        if (!sink) {
          settle();
          return;
        }
        sink.end(settle);
      });
    },
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
