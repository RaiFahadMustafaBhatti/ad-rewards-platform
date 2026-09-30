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
//
// NOTE: this module uses the tiny `aws4` SigV4 signer + global fetch instead
// of the AWS SDK. The SDK was dropped during the Vercel investigation because
// it was a suspect, but the confirmed function crashers were different: (1)
// Vercel's TS processing not resolving the local ../server imports (fixed by
// pre-bundling api-src/index.ts -> api/index.js with esbuild), and (2) the
// firebase-admin/auth + jwks-rsa + CJS require("jose") conflict against the
// ESM-only jose package (fixed by verifying Firebase ID tokens with jose
// directly). The aws4 rewrite stays because it keeps the serverless bundle
// small and dependency-free.

import aws4 from "aws4";

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

function endpointParts(config: B2Config): { host: string; region: string } {
  const url = new URL(config.endpoint);
  return { host: url.host, region: resolveRegion(config.endpoint) };
}

/** Store a file in the private B2 bucket. Returns the storage key. */
export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const config = getB2Config();
  const { host, region } = endpointParts(config);
  const key = appendHashSuffix(normalizeKey(relKey));
  const body = toBody(data);

  const signed = aws4.sign(
    {
      host,
      method: "PUT",
      path: `/${config.bucket}/${key}`,
      service: "s3",
      region,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
      },
      body: Buffer.from(body).toString("utf8"),
    },
    { accessKeyId: config.keyId, secretAccessKey: config.applicationKey },
  );

  const res = await fetch(`https://${host}/${config.bucket}/${key}`, {
    method: "PUT",
    headers: signed.headers as Record<string, string>,
    body: Buffer.from(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`B2 PutObject failed (${res.status}): ${text.slice(0, 300)}`);
  }

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
  const { host, region } = endpointParts(config);
  const key = normalizeKey(relKey);

  const presigned = aws4.sign(
    {
      host,
      method: "GET",
      path: `/${config.bucket}/${key}?X-Amz-Expires=${SIGNED_URL_TTL_SECONDS}`,
      service: "s3",
      region,
      signQuery: true,
    },
    { accessKeyId: config.keyId, secretAccessKey: config.applicationKey },
  );
  return `https://${presigned.host}${presigned.path}`;
}
