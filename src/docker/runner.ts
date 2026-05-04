import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigMount } from '../adapters/types.js';
import { redactJson, redactString, type Redaction } from '../redaction.js';
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
  configMounts: ConfigMount[];
  runDir: string;
  caseId: string;
  agentName: string;
  timeoutMs: number;
  redactions: readonly Redaction[];
}

export interface DockerRunResult {
  image: string;
  command: string[];
  argv: string[];
  stdout: string;
  stderr: string;
  stdoutPath: string;
  stderrPath: string;
  commandPath: string;
  exitCode: number | null;
  durationMs: number;
  errorMessage?: string;
}

export async function runInDocker(options: DockerRunOptions): Promise<DockerRunResult> {
  await mkdir(options.runDir, { recursive: true });

  const stdoutPath = join(options.runDir, 'stdout.log');
  const stderrPath = join(options.runDir, 'stderr.log');
  const commandPath = join(options.runDir, 'command.redacted.json');
  const containerName = buildContainerName(options.caseId, options.agentName);
  const dockerArgs = buildDockerArgs({
    image: options.image,
    containerName,
    workdir: options.workdir,
    home: options.home,
    workspaceMount: { source: options.workspaceDir, target: options.workspaceTarget, readonly: false },
    configMount: { source: options.configDir, target: options.configTarget, readonly: false },
    configMounts: options.configMounts,
    envNames: options.envNames,
    envValues: options.envValues,
    argv: options.argv,
  });
  const command = ['docker', ...dockerArgs];

  await writeFile(
    commandPath,
    `${JSON.stringify(redactJson({
      command,
      image: options.image,
      containerName,
      argv: options.argv,
      env: {
        ...(options.envValues ?? {}),
        ...Object.fromEntries(options.envNames.map((name) => [name, process.env[name] ?? null])),
      },
      mounts: {
        workspace: { source: options.workspaceDir, target: options.workspaceTarget, readonly: false },
        config: { source: options.configDir, target: options.configTarget, readonly: false },
        extra: options.configMounts,
      },
      timeoutMs: options.timeoutMs,
    }, options.redactions), null, 2)}\n`,
  );

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

  await writeFile(stdoutPath, redactString(stdout, options.redactions));
  await writeFile(stderrPath, redactString(stderr, options.redactions));

  return {
    image: options.image,
    command: redactJson(command, options.redactions),
    argv: redactJson(options.argv, options.redactions),
    stdout,
    stderr,
    stdoutPath,
    stderrPath,
    commandPath,
    exitCode,
    durationMs: Date.now() - startedAt,
    errorMessage,
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
