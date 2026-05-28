import { join } from 'node:path';
import type { ConfigMount } from '../adapters/types.js';
import type { NetworkPolicyConfig } from '../config/schema.js';

export interface DockerArgsOptions {
  image: string;
  containerName: string;
  workdir: string;
  home: string;
  workspaceMount: { source: string; target: string; readonly: boolean };
  configMount: { source: string; target: string; readonly: boolean };
  configMounts: ConfigMount[];
  envNames: string[];
  envValues?: Record<string, string>;
  network?: NetworkPolicyConfig;
  argv: string[];
}

export function buildDockerArgs(options: DockerArgsOptions): string[] {
  const args = [
    'run',
    '--rm',
    '--name',
    options.containerName,
    '--workdir',
    options.workdir,
    '--mount',
    bindMount(options.workspaceMount.source, options.workspaceMount.target, options.workspaceMount.readonly),
    '--mount',
    bindMount(options.configMount.source, options.configMount.target, options.configMount.readonly),
    '-e',
    `HOME=${options.home}`,
  ];

  args.push(...networkArgs(options.network));

  for (const mount of options.configMounts) {
    args.push('--mount', bindMount(mount.source, mount.target, mount.readonly));
  }

  const user = getUserMapping();
  if (user) args.push('--user', user);

  for (const [name, value] of Object.entries(options.envValues ?? {})) {
    args.push('-e', `${name}=${value}`);
  }

  for (const name of options.envNames) {
    args.push('-e', name);
  }

  args.push(options.image, ...options.argv);
  return args;
}

function networkArgs(network: NetworkPolicyConfig | undefined): string[] {
  if (!network || network.mode === 'default') return [];
  if (network.mode === 'none') return ['--network', 'none'];
  return ['--network', 'bridge'];
}

export function bindMount(source: string, target: string, readonly: boolean): string {
  const normalizedTarget = target.startsWith('/') ? target : join('/', target);
  return `type=bind,source=${source},target=${normalizedTarget}${readonly ? ',readonly' : ''}`;
}

function getUserMapping(): string | undefined {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return undefined;
  return `${process.getuid()}:${process.getgid()}`;
}
