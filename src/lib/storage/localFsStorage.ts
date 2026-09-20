import fs from "fs/promises";
import path from "path";
import { StorageDriver, assertSafeStorageKey } from "@/lib/storage/types";
import { buildSignedPath } from "@/lib/storage/localFsSigning";

function getBaseDir(): string {
  return path.resolve(process.env.LOCAL_STORAGE_DIR || ".data/storage");
}

/** Resolves a key to an absolute path, refusing anything that would escape baseDir. */
function resolveWithinBase(key: string): string {
  assertSafeStorageKey(key);
  const baseDir = getBaseDir();
  const resolved = path.resolve(baseDir, key);
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    throw new Error(`Storage key resolves outside the storage root: ${key}`);
  }
  return resolved;
}

export class LocalFsStorageDriver implements StorageDriver {
  readonly name = "local" as const;

  async upload(key: string, body: Buffer, _contentType: string): Promise<string> {
    const filePath = resolveWithinBase(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body);
    return key;
  }

  async download(key: string): Promise<Buffer> {
    return fs.readFile(resolveWithinBase(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(resolveWithinBase(key), { force: true });
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    assertSafeStorageKey(key);
    const base = process.env.APP_BASE_URL || "http://localhost:3000";
    return `${base}${buildSignedPath(key, expiresInSeconds)}`;
  }
}
