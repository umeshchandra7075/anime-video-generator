export interface StorageDriver {
  readonly name: "local" | "s3";
  upload(key: string, body: Buffer, contentType: string): Promise<string>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

/**
 * Rejects any key that could escape its namespaced directory (path
 * traversal) or that contains characters unsafe for a filesystem/URL path.
 * All storage keys in this app are built by projectStorageKey() from a UUID
 * and small fixed segments, so a well-formed key should never hit this -
 * this is defense in depth, not the primary validation.
 */
export function assertSafeStorageKey(key: string): void {
  if (!key || key.startsWith("/") || key.includes("..") || key.includes("\\")) {
    throw new Error(`Unsafe storage key rejected: ${key}`);
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(key)) {
    throw new Error(`Storage key contains unsupported characters: ${key}`);
  }
}
