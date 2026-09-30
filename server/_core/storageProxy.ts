import type { Express } from "express";
import { getB2Config, storageGetSignedUrl } from "../storage";

/**
 * Internal redirect proxy for stored files: /storage/<key> -> 307 to a
 * short-lived B2 presigned URL. Objects stay private in the bucket; the
 * presigned URL is minted per request and expires in 15 minutes.
 *
 * Authorization for sensitive files (payment proofs) happens one layer up in
 * getAuthorizedPaymentProofUrl, which checks owner/admin before minting a
 * signed URL. Keys are unguessable (uuid + hash suffix), so the proxy itself
 * carries no session requirement, matching the previous behavior.
 */
export function registerStorageProxy(app: Express) {
  app.get("/storage/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }

    try {
      getB2Config();
    } catch {
      res.status(500).send("Storage proxy not configured");
      return;
    }

    try {
      const url = await storageGetSignedUrl(decodeURIComponent(key));
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}
