export function isWorkspaceIgnored(path: string, patterns: readonly string[]): boolean {
  if (!path) return false;
  const normalized = normalizeWorkspacePath(path);
  const parts = normalized.split('/');

  return patterns.some((pattern) => {
    const normalizedPattern = normalizeWorkspacePath(pattern).replace(/^\/+|\/+$/g, '');
    if (!normalizedPattern) return false;
    if (!normalizedPattern.includes('*') && !normalizedPattern.includes('/')) {
      return parts.includes(normalizedPattern);
    }
    if (!normalizedPattern.includes('*')) {
      return normalized === normalizedPattern || normalized.startsWith(`${normalizedPattern}/`);
    }
    const regex = new RegExp(`^${escapeRegex(normalizedPattern).replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*')}(?:/.*)?$`);
    return regex.test(normalized);
  });
}

export function normalizeWorkspacePath(path: string): string {
  return path.split('\\').join('/');
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, '\\$&');
}
