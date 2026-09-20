import { StorageDriver } from "@/lib/storage/types";
import { LocalFsStorageDriver } from "@/lib/storage/localFsStorage";
import { S3StorageDriver } from "@/lib/storage/s3Storage";

let driverSingleton: StorageDriver | undefined;

/**
 * Local filesystem storage is the default so `npm run dev` works with zero
 * external services. Set STORAGE_DRIVER=s3 (and the STORAGE_* credentials)
 * for production - see README "Production database & storage".
 */
export function getStorageDriver(): StorageDriver {
  if (!driverSingleton) {
    const explicit = process.env.STORAGE_DRIVER;
    const driver =
      explicit === "s3" ? "s3" : explicit === "local" ? "local" : process.env.STORAGE_ENDPOINT ? "s3" : "local";
    driverSingleton = driver === "s3" ? new S3StorageDriver() : new LocalFsStorageDriver();
  }
  return driverSingleton;
}

export async function uploadObject(key: string, body: Buffer, contentType: string): Promise<string> {
  return getStorageDriver().upload(key, body, contentType);
}

export async function downloadObject(key: string): Promise<Buffer> {
  return getStorageDriver().download(key);
}

export async function deleteObject(key: string): Promise<void> {
  return getStorageDriver().delete(key);
}

export async function getSignedDownloadUrl(key: string, expiresInSeconds = 900): Promise<string> {
  return getStorageDriver().getSignedUrl(key, expiresInSeconds);
}

export function projectStorageKey(projectId: string, ...parts: string[]): string {
  return ["projects", projectId, ...parts].join("/");
}
