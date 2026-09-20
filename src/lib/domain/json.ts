// SQLite has no native JSON column type, so fields that hold structured data
// are stored as TEXT and JSON-encoded/decoded at the application boundary.
// Centralizing this avoids scattering try/catch JSON.parse calls everywhere.

export function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

export function fromJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
