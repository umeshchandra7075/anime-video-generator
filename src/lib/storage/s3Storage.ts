import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { StorageDriver, assertSafeStorageKey } from "@/lib/storage/types";

function getClient(): S3Client {
  const endpoint = process.env.STORAGE_ENDPOINT;
  const region = process.env.STORAGE_REGION ?? "auto";
  const accessKeyId = process.env.STORAGE_ACCESS_KEY;
  const secretAccessKey = process.env.STORAGE_SECRET_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "S3 storage is not configured. Set STORAGE_ENDPOINT, STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY (or unset STORAGE_DRIVER to use local storage in dev).",
    );
  }

  return new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true, // works for most S3-compatible providers (R2, MinIO, B2)
  });
}

function getBucket(): string {
  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) throw new Error("Missing required environment variable: STORAGE_BUCKET");
  return bucket;
}

export class S3StorageDriver implements StorageDriver {
  readonly name = "s3" as const;

  async upload(key: string, body: Buffer, contentType: string): Promise<string> {
    assertSafeStorageKey(key);
    const client = getClient();
    await client.send(
      new PutObjectCommand({ Bucket: getBucket(), Key: key, Body: body, ContentType: contentType }),
    );
    return key;
  }

  async download(key: string): Promise<Buffer> {
    assertSafeStorageKey(key);
    const client = getClient();
    const result = await client.send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
    const stream = result.Body as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    assertSafeStorageKey(key);
    const client = getClient();
    await client.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    assertSafeStorageKey(key);
    const client = getClient();
    const command = new GetObjectCommand({ Bucket: getBucket(), Key: key });
    return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
  }
}
