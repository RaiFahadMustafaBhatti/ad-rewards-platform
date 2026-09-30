import "dotenv/config";
import express, { type Express } from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerFirebaseAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";

/**
 * Build the Express application WITHOUT binding a port or serving static
 * files. Shared by:
 *  - the long-running local/production server (server/_core/index.ts), and
 *  - the Vercel serverless entrypoint (api/index.ts).
 *
 * This module intentionally never imports dev-only tooling (Vite), so the
 * serverless bundle stays lean. Static files are served by Express only in
 * the long-running server; on Vercel the CDN serves dist/public directly.
 *
 * All persistent state lives outside the process: Firestore (via the
 * Firebase Admin SDK) for data and the configured upload storage for files.
 * Nothing is written to the local filesystem, so this is safe on serverless
 * infrastructure.
 */
export function createApp(): Express {
  const app = express();

  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  registerStorageProxy(app);
  registerFirebaseAuthRoutes(app);

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  return app;
}
