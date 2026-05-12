import { access } from 'node:fs/promises';
import { expandTrustedPath } from '../config/paths.js';
import type { AgentStepPrepareInput, ConfigMount } from './types.js';

export interface CurrentAuthOptions {
  adapterConfigName: string;
  configEnvName: string;
  defaultConfigDirs: readonly string[];
  credentialEnvNames: readonly string[];
}

export interface CurrentAuthMetadata {
  sourcePath: string;
  targetPath: string;
  sourceExists: boolean;
  useCurrentConfig: boolean;
  mounted: boolean;
  skippedBecauseEnvCredentialAvailable: boolean;
}

export interface CurrentAuthPlan {
  envNames: string[];
  envValues?: Record<string, string>;
  configMounts: ConfigMount[];
  metadata: CurrentAuthMetadata;
}

export async function prepareCurrentAuth(input: AgentStepPrepareInput, options: CurrentAuthOptions): Promise<CurrentAuthPlan> {
  const useCurrentConfig = readBoolean(input.agent.config?.useCurrentConfig) ?? input.agent.useCurrentConfig ?? true;
  const sourcePath = await currentConfigDir(input, options);
  const targetPath = `${input.docker.configRoot.replace(/\/+$/, '')}/${options.adapterConfigName}`;
  const sourceExists = await pathExists(sourcePath);
  const envCredentialAvailable = hasEnvValue(input.agent.apiKeyEnv) || options.credentialEnvNames.some(hasEnvValue);
  const mounted = useCurrentConfig && !envCredentialAvailable && sourceExists;

  return {
    envNames: credentialEnvNames(input.agent.apiKeyEnv, options.credentialEnvNames),
    envValues: mounted ? { [options.configEnvName]: targetPath } : undefined,
    configMounts: mounted ? [{ source: sourcePath, target: targetPath, readonly: true }] : [],
    metadata: {
      sourcePath,
      targetPath,
      sourceExists,
      useCurrentConfig,
      mounted,
      skippedBecauseEnvCredentialAvailable: envCredentialAvailable,
    },
  };
}

async function currentConfigDir(input: AgentStepPrepareInput, options: CurrentAuthOptions): Promise<string> {
  const configured = readString(input.agent.userConfigDirs?.[0]);
  if (configured) return expandTrustedPath(configured);

  const envConfigured = readString(process.env[options.configEnvName]);
  if (envConfigured) return expandTrustedPath(envConfigured);

  const defaults = options.defaultConfigDirs.map(expandTrustedPath).filter(Boolean);
  if (defaults.length === 0) throw new Error(`Adapter ${input.agentName} requires at least one default config directory`);

  for (const path of defaults) {
    if (await pathExists(path)) return path;
  }
  return defaults[0];
}

function credentialEnvNames(apiKeyEnv: string | undefined, adapterEnvNames: readonly string[]): string[] {
  return unique([apiKeyEnv, ...adapterEnvNames.filter(hasEnvValue)]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hasEnvValue(name: string | undefined): boolean {
  return Boolean(name && readString(process.env[name]));
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
