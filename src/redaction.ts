export interface Redaction {
  name: string;
  value: string;
  replacement: string;
}

const SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;

export function redactionsFromEnv(names: readonly string[]): Redaction[] {
  const seenValues = new Set<string>();
  const redactions: Redaction[] = [];

  for (const name of names) {
    if (!SECRET_NAME_PATTERN.test(name)) continue;

    const value = process.env[name];
    if (!value || seenValues.has(value)) continue;

    seenValues.add(value);
    redactions.push({ name, value, replacement: `<redacted:${name}>` });
  }

  return redactions.sort((a, b) => b.value.length - a.value.length);
}

export function redactionsFromValues(values: Array<{ name: string; value?: string }>): Redaction[] {
  return values
    .filter((entry): entry is { name: string; value: string } => Boolean(entry.value))
    .map((entry) => ({ name: entry.name, value: entry.value, replacement: `<redacted:${entry.name}>` }))
    .sort((a, b) => b.value.length - a.value.length);
}

export function redactString(value: string, redactions: readonly Redaction[]): string {
  let redacted = value;
  for (const redaction of redactions) {
    redacted = redacted.split(redaction.value).join(redaction.replacement);
  }
  return redacted;
}

export function redactJson<T>(value: T, redactions: readonly Redaction[]): T {
  return redactUnknown(value, redactions) as T;
}

function redactUnknown(value: unknown, redactions: readonly Redaction[]): unknown {
  if (typeof value === 'string') return redactString(value, redactions);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, redactions));

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactUnknown(child, redactions)]));
  }

  return value;
}
