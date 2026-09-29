/**
 * Vercel serverless entrypoint.
 *
 * Vercel's CDN serves the built client (dist/public) directly; requests to
 * /api/* are rewritten here (see vercel.json). The Express app is built once
 * per function instance (cold start) and reused for warm invocations.
 *
 * Persistent state lives outside the function: the Manus MySQL database
 * (DATABASE_URL) and uploads via Forge S3 presigned URLs. Sessions are
 * stateless JWT cookies. Nothing is written to the ephemeral filesystem,
 * so this is safe on serverless infrastructure.
 */
import { createApp } from "../server/_core/app";

const app = createApp();

export default app;
