import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

export interface SeedWorkspaceFromImageInput {
  image: string;
  seedPath: string;
  workspaceDir: string;
  timeoutMs?: number;
}

/**
 * Seeds the run workspace by extracting `seedPath` (e.g. /app) from a Docker
 * image into `workspaceDir` on the host. Unlike workspace copy, this includes
 * everything under the path (notably `.git`), because Harbor/DeepSWE verifiers
 * need the repository history present to diff against the base commit.
 *
 * Implemented with `docker create` + `docker cp` + `docker rm` (no container is
 * ever started), so it works for any image regardless of its entrypoint.
 */
export async function seedWorkspaceFromImage(input: SeedWorkspaceFromImageInput): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 300_000;
  await mkdir(input.workspaceDir, { recursive: true });

  const created = spawnSync('docker', ['create', input.image], { encoding: 'utf8', timeout: timeoutMs });
  if (created.status !== 0) {
    throw new Error(`Failed to create container from image ${input.image}: ${created.stderr || created.error?.message || `exit ${created.status}`}`);
  }
  const containerId = created.stdout.trim();
  if (!containerId) throw new Error(`docker create returned no container id for image ${input.image}`);

  try {
    // Trailing `/.` copies the directory contents into workspaceDir rather than
    // nesting them under a `<seedPath basename>/` subdirectory.
    const seedPath = input.seedPath.replace(/\/+$/, '');
    const copied = spawnSync('docker', ['cp', `${containerId}:${seedPath}/.`, input.workspaceDir], { encoding: 'utf8', timeout: timeoutMs });
    if (copied.status !== 0) {
      throw new Error(`Failed to copy ${seedPath} from image ${input.image}: ${copied.stderr || copied.error?.message || `exit ${copied.status}`}`);
    }
  } finally {
    spawnSync('docker', ['rm', '-f', containerId], { stdio: 'ignore', timeout: timeoutMs });
  }
}
