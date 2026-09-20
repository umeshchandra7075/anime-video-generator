import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { verifySignedRequest } from "@/lib/storage/localFsSigning";
import { assertSafeStorageKey } from "@/lib/storage/types";

interface Params {
  params: { path: string[] };
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".srt": "application/x-subrip",
};

/**
 * This route only exists to make the local filesystem storage driver behave
 * like a real object store with expiring signed URLs (see
 * src/lib/storage/localFsSigning.ts) - it is not used when STORAGE_DRIVER=s3.
 * A request without a valid, unexpired signature is rejected outright; there
 * is no other authorization check here because the signature itself is the
 * capability (exactly like a real S3 presigned URL).
 */
export async function GET(req: NextRequest, { params }: Params) {
  const key = params.path.join("/");

  try {
    assertSafeStorageKey(key);
  } catch {
    return NextResponse.json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const valid = verifySignedRequest(key, searchParams.get("exp"), searchParams.get("sig"));
  if (!valid) {
    return NextResponse.json(
      { success: false, error: { code: "UNAUTHORIZED", message: "This link is invalid or has expired." } },
      { status: 401 },
    );
  }

  const baseDir = path.resolve(process.env.LOCAL_STORAGE_DIR || ".data/storage");
  const filePath = path.resolve(baseDir, key);
  if (!filePath.startsWith(baseDir + path.sep)) {
    return NextResponse.json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 });
  }

  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch {
    return NextResponse.json({ success: false, error: { code: "NOT_FOUND", message: "File not found." } }, { status: 404 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

  return new NextResponse(data, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(data.length),
      "Cache-Control": "private, max-age=60",
    },
  });
}
