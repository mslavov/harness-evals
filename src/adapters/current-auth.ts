import { access, chmod, copyFile, mkdir, readdir, readlink, realpath, symlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { expandTrustedPath } from '../config/paths.js';
import type { AgentStepPrepareInput, ConfigMount } from './types.js';

export interface CurrentAuthSiblingFile {
  sourcePath: string;
  targetName: string;
}

export interface CurrentAuthOptions {
  adapterConfigName: string;
  configEnvName: string;
  defaultConfigDirs: readonly string[];
  credentialEnvNames: readonly string[];
  secretFiles?: readonly string[];
  excludeDirs?: readonly string[];
  siblingFiles?: readonly CurrentAuthSiblingFile[];
}

export interface CurrentAuthMetadata {
  sourcePath: string;
  targetPath: string;
  sourceExists: boolean;
  useCurrentConfig: boolean;
  copied: boolean;
  envCredentialAvailable: boolean;
  copiedSiblings: string[];
  excludedDirs: string[];
  warnings: string[];
}

export interface CurrentAuthPlan {
  envNames: string[];
  envValues?: Record<string, string>;
  configMounts: ConfigMount[];
  cleanupPaths?: string[];
  metadata: CurrentAuthMetadata;
}

export async function prepareCurrentAuth(input: AgentStepPrepareInput, options: CurrentAuthOptions): Promise<CurrentAuthPlan> {
  const config = input.agent.config ?? {};
  const useCurrentConfig =
    readBoolean(config.useCurrentConfig) ?? readBoolean(config.copyCurrentConfig) ?? input.agent.useCurrentConfig ?? true;
  const sourcePath = await currentConfigDir(input, options);
  const containerTargetPath = `${input.docker.configRoot.replace(/\/+$/, '')}/${options.adapterConfigName}`;
  const hostTargetPath = join(input.configDir, options.adapterConfigName);
  const sourceExists = await pathExists(sourcePath);
  const envCredentialAvailable = hasEnvValue(input.agent.apiKeyEnv) || options.credentialEnvNames.some(hasEnvValue);
  const shouldCopy = useCurrentConfig && sourceExists;

  const envNames = credentialEnvNames(input.agent.apiKeyEnv, options.credentialEnvNames);

  if (!shouldCopy) {
    return {
      envNames,
      envValues: undefined,
      configMounts: [],
      metadata: {
        sourcePath,
        targetPath: containerTargetPath,
        sourceExists,
        useCurrentConfig,
        copied: false,
        envCredentialAvailable,
        copiedSiblings: [],
        excludedDirs: [],
        warnings: [],
      },
    };
  }

  const excludeDirs = resolveExcludeDirs(options.excludeDirs, config);
  const secretFiles = new Set(options.secretFiles ?? []);
  const warnings: string[] = [];

  await mkdir(hostTargetPath, { recursive: true });
  await copyConfigTree(sourcePath, hostTargetPath, { excludeDirs, secretFiles, warnings });

  const copiedSiblings = await copySiblingFiles(options.siblingFiles, hostTargetPath, secretFiles, warnings);

  return {
    envNames,
    envValues: { [options.configEnvName]: containerTargetPath },
    configMounts: [],
    cleanupPaths: [hostTargetPath],
    metadata: {
      sourcePath,
      targetPath: containerTargetPath,
      sourceExists,
      useCurrentConfig,
      copied: true,
      envCredentialAvailable,
      copiedSiblings,
      excludedDirs: [...excludeDirs],
      warnings,
    },
  };
}

interface CopyConfigTreeOptions {
  excludeDirs: Set<string>;
  secretFiles: Set<string>;
  warnings: string[];
}

async function copyConfigTree(src: string, dest: string, options: CopyConfigTreeOptions): Promise<void> {
  const srcRoot = await realpath(src);

  const walk = async (currentSrc: string, currentDest: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(currentSrc, { withFileTypes: true });
    } catch (error) {
      options.warnings.push(`Skipped unreadable directory ${currentSrc}: ${errorMessage(error)}`);
      return;
    }

    for (const entry of entries) {
      const sourceEntry = join(currentSrc, entry.name);
      const destEntry = join(currentDest, entry.name);

      try {
        if (entry.isDirectory()) {
          if (options.excludeDirs.has(entry.name)) continue;
          await mkdir(destEntry, { recursive: true });
          await walk(sourceEntry, destEntry);
          continue;
        }

        if (entry.isSymbolicLink()) {
          await copySymlink(sourceEntry, destEntry, srcRoot, options.warnings);
          continue;
        }

        if (entry.isFile()) {
          await copyFile(sourceEntry, destEntry);
          if (options.secretFiles.has(entry.name)) await chmod(destEntry, 0o600);
        }
      } catch (error) {
        options.warnings.push(`Skipped ${sourceEntry}: ${errorMessage(error)}`);
      }
    }
  };

  await walk(src, dest);
}

async function copySymlink(sourceEntry: string, destEntry: string, srcRoot: string, warnings: string[]): Promise<void> {
  const linkTarget = await readlink(sourceEntry);
  const resolved = isAbsolute(linkTarget) ? resolve(linkTarget) : resolve(sourceEntry, '..', linkTarget);
  const rel = relative(srcRoot, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    warnings.push(`Skipped symlink pointing outside config dir: ${sourceEntry} -> ${linkTarget}`);
    return;
  }
  await symlink(linkTarget, destEntry);
}

async function copySiblingFiles(
  siblingFiles: readonly CurrentAuthSiblingFile[] | undefined,
  hostTargetPath: string,
  secretFiles: Set<string>,
  warnings: string[],
): Promise<string[]> {
  if (!siblingFiles?.length) return [];
  const copied: string[] = [];

  for (const sibling of siblingFiles) {
    if (!(await pathExists(sibling.sourcePath))) continue;
    const destEntry = join(hostTargetPath, sibling.targetName);
    try {
      await copyFile(sibling.sourcePath, destEntry);
      if (secretFiles.has(sibling.targetName)) await chmod(destEntry, 0o600);
      copied.push(sibling.targetName);
    } catch (error) {
      warnings.push(`Skipped sibling ${sibling.sourcePath}: ${errorMessage(error)}`);
    }
  }

  return copied;
}

function resolveExcludeDirs(defaults: readonly string[] | undefined, config: Record<string, unknown>): Set<string> {
  const result = new Set(defaults ?? []);
  for (const dir of readStringArray(config.configExcludeDirs)) result.add(dir);
  for (const dir of readStringArray(config.configIncludeDirs)) result.delete(dir);
  return result;
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
