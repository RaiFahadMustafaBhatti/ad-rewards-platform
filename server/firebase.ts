// Firebase Admin SDK bootstrap for the server.
//
// Credentials come from the service-account JSON the project owner downloads
// at Firebase console > Project settings > Service accounts. Only the three
// fields below are needed; the private key itself never passes through chat,
// code, or memory - it lives in environment variables / the host's secret
// store (e.g. Vercel environment variables).
//
// When the credentials are absent (local dev without a service account),
// every accessor returns null and the data layer degrades gracefully, the
// same way it previously did without DATABASE_URL.

import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore as getAdminFirestore, type Firestore } from "firebase-admin/firestore";
import { createRemoteJWKSet, jwtVerify } from "jose";

// NOTE: firebase-admin/auth is intentionally NOT imported here. It pulls in
// jwks-rsa@4 (CommonJS) which does require("jose") where jose is ESM-only -
// that crashes on runtimes whose CJS loader cannot require() ESM (Vercel).
// ID tokens are verified with jose directly instead (see verifyFirebaseIdToken).

let app: App | null = null;
let initAttempted = false;

function readServiceAccount(): {
  projectId: string;
  clientEmail: string;
  privateKey: string;
} | null {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  let privateKey = process.env.FIREBASE_PRIVATE_KEY ?? "";
  // Vercel-style env vars store the PEM with literal "\n" sequences.
  if (privateKey.includes("\\n")) privateKey = privateKey.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey: privateKey.trim() };
}

export function getFirebaseApp(): App | null {
  if (app) return app;
  if (initAttempted) return null;
  initAttempted = true;
  const serviceAccount = readServiceAccount();
  if (!serviceAccount) return null;
  try {
    const existing = getApps();
    app =
      existing.length > 0
        ? existing[0]
        : initializeApp({
            credential: cert(serviceAccount),
            projectId: serviceAccount.projectId,
          });
  } catch (error) {
    console.warn("[Firebase] Admin SDK initialization failed:", error);
    app = null;
  }
  return app;
}

export function isFirebaseConfigured(): boolean {
  return getFirebaseApp() !== null;
}

let firestoreInstance: Firestore | null = null;

export function getFirestore(): Firestore | null {
  const firebaseApp = getFirebaseApp();
  if (!firebaseApp) return null;
  try {
    if (!firestoreInstance) {
      firestoreInstance = getAdminFirestore(firebaseApp);
      // Use the REST transport instead of gRPC. Serverless instances cannot
      // reuse gRPC channels across invocations, and channel setup was adding
      // ~10s to every API request. REST is stateless per request.
      firestoreInstance.settings({ preferRest: true });
    }
    return firestoreInstance;
  } catch (error) {
    console.warn("[Firebase] Firestore unavailable:", error);
    return null;
  }
}

export interface VerifiedFirebaseToken {
  uid: string;
  name?: string;
  email?: string;
  emailVerified?: boolean;
}

const SECURE_TOKEN_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let remoteJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * Verify a Firebase ID token (Google sign-in) with jose.
 *
 * Checks signature (Google securetoken JWKS), issuer, audience and expiry -
 * the same core checks firebase-admin's verifyIdToken performs.
 * Returns null when Firebase is not configured or the token is invalid.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
): Promise<VerifiedFirebaseToken | null> {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId || !idToken) return null;
  try {
    if (!remoteJwks) {
      remoteJwks = createRemoteJWKSet(new URL(SECURE_TOKEN_JWKS_URL));
    }
    const { payload } = await jwtVerify(idToken, remoteJwks, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return {
      uid: payload.sub,
      name: typeof payload.name === "string" ? payload.name : undefined,
      email: typeof payload.email === "string" ? payload.email : undefined,
      emailVerified: payload.email_verified === true,
    };
  } catch (error) {
    console.warn(
      "[Firebase] ID token verification failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
