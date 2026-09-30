// Private file storage on Backblaze B2 (S3-compatible API).
//
// Why B2: the free tier covers 10 GB storage + 1 GB/day egress, uploads are
// free, private buckets are the default, and commercial use is allowed -
// unlike Vercel Blob Hobby (non-commercial only) and Firebase Storage
// (requires the paid Blaze plan).
//
// Payment proofs are never public: the bucket stays private and every read
// goes through a short-lived presigned URL minted server-side. Writes happen
// server-side with PutObject, so no credentials ever reach the browser.

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const SIGNED_URL_TTL_SECONDS = 15 * 60;

export interface B2Config {
  keyId: string;
  applicationKey: string;
  bucket: string;
  endpoint: string;
}

export function getB2Config(): B2Config {
  const keyId = process.env.B2_KEY_ID?.trim() ?? "";
  const applicationKey = process.env.B2_APPLICATION_KEY ?? "";
  const bucket = process.env.B2_BUCKET?.trim() ?? "";
  const endpoint = (process.env.B2_ENDPOINT?.trim() ?? "").replace(/\/+$/, "");
  if (!keyId || !applicationKey || !bucket || !endpoint) {
    throw new Error(
      "Storage config missing: set B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET and B2_ENDPOINT (e.g. https://s3.us-west-004.backblazeb2.com).",
    );
  }
  return { keyId, applicationKey, bucket, endpoint };
}

let client: S3Client | null = null;

/**
 * B2's S3-compatible API signs requests with SigV4, which needs the region
 * matching the endpoint (e.g. https://s3.us-west-004.backblazeb2.com ->
 * us-west-004). Derive it from B2_ENDPOINT so a bucket created in any region
 * works; B2_REGION overrides when set explicitly.
 */
function resolveRegion(endpoint: string): string {
  const override = process.env.B2_REGION?.trim();
  if (override) return override;
  const match = endpoint.match(/^https?:\/\/s3\.([^.]+)\.backblazeb2\.com/i);
  if (match) return match[1];
  return "us-east-005";
}

function getS3Client(): S3Client {
  if (client) return client;
  const config = getB2Config();
  client = new S3Client({
    region: resolveRegion(config.endpoint),
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.keyId,
      secretAccessKey: config.applicationKey,
    },
    // B2's S3-compatible endpoint needs path-style addressing.
    forcePathStyle: true,
  });
  return client;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

function toBody(data: Buffer | Uint8Array | string): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** Store a file in the private B2 bucket. Returns the storage key. */
export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const config = getB2Config();
  const key = appendHashSuffix(normalizeKey(relKey));

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: toBody(data),
      ContentType: contentType,
    }),
  );

  return { key, url: `/storage/${encodeURIComponent(key)}` };
}

/** Reference an already-stored file via the internal proxy path. */
export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: `/storage/${encodeURIComponent(key)}` };
}

/**
 * Mint a short-lived presigned GET URL for a private object. Used for
 * owner/admin-only downloads such as payment proof screenshots.
 */
export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const config = getB2Config();
  const key = normalizeKey(relKey);
  return getSignedUrl(
    getS3Client(),
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    { expiresIn: SIGNED_URL_TTL_SECONDS },
  );
}
