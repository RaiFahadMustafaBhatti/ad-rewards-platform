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
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore as getAdminFirestore, type Firestore } from "firebase-admin/firestore";

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

export function getFirestore(): Firestore | null {
  const firebaseApp = getFirebaseApp();
  if (!firebaseApp) return null;
  try {
    return getAdminFirestore(firebaseApp);
  } catch (error) {
    console.warn("[Firebase] Firestore unavailable:", error);
    return null;
  }
}

export function getFirebaseAuth(): Auth | null {
  const firebaseApp = getFirebaseApp();
  if (!firebaseApp) return null;
  try {
    return getAuth(firebaseApp);
  } catch (error) {
    console.warn("[Firebase] Auth unavailable:", error);
    return null;
  }
}
