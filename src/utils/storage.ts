import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { r2Config } from "./env";

// ─────────────────────────────────────────────────────────────
// OBJECT STORAGE (Cloudflare R2, via the S3 API)
//
// R2 speaks S3, so the AWS SDK works unchanged once pointed at the R2
// endpoint with `region: "auto"`. The BE uploads with secret keys (the
// back door); browsers read the finished files from the public base URL
// (the front door). Two different doors on the same bucket.
// ─────────────────────────────────────────────────────────────

let client: S3Client | null = null;

// Build the client lazily and once. Returns null when R2 isn't configured
// so callers can degrade gracefully instead of throwing at import time.
function getClient(): S3Client | null {
  const cfg = r2Config();
  if (!cfg) return null;
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }
  return client;
}

export function isStorageConfigured(): boolean {
  return r2Config() !== null;
}

// Upload bytes under `key` and return the public URL to read them back.
// Throws if R2 isn't configured (guard with isStorageConfigured first) or
// the PUT fails.
export async function putObject(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<string> {
  const cfg = r2Config();
  const c = getClient();
  if (!cfg || !c) throw new Error("R2 storage is not configured");

  await c.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  return `${cfg.publicBaseUrl}/${key}`;
}

// List objects under a key prefix (paginates internally). Returns each object's
// key + last-modified date. Used by the backup job to find old dumps to prune.
export async function listObjects(
  prefix: string,
): Promise<{ key: string; lastModified: Date }[]> {
  const cfg = r2Config();
  const c = getClient();
  if (!cfg || !c) throw new Error("R2 storage is not configured");

  const out: { key: string; lastModified: Date }[] = [];
  let token: string | undefined;
  do {
    const res = await c.send(
      new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) out.push({ key: o.Key, lastModified: o.LastModified ?? new Date(0) });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

// Delete a single object by key.
export async function deleteObject(key: string): Promise<void> {
  const cfg = r2Config();
  const c = getClient();
  if (!cfg || !c) throw new Error("R2 storage is not configured");
  await c.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}
