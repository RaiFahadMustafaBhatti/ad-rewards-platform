# FMB Earning Hub — Advertising Rewards Platform

## Purpose

FMB Earning Hub is a full-stack advertising rewards and digital membership application. It is designed as a **verified advertising participation service**, not as an investment product. The public interface and member flows explicitly avoid profit, return, passive-income, or guaranteed-earning claims.

## Implemented Scope

| Area | Included implementation |
|---|---|
| Public experience | Responsive landing page, package comparison, process explanation, FAQ, contact placeholders, and policy/disclosure routes. |
| Memberships | Configurable Platinum, Gold, and Diamond package records with editable price, eligible-ad reward, daily limit, duration, and availability. |
| Payment verification | Authenticated manual proof submission with image validation, transaction-ID uniqueness, private B2 storage keys, approval/rejection flow, notifications, and audit entries. |
| Ad campaigns | Administrator campaign creation; protected member sessions; server-side duration, eligibility, daily-limit, campaign-budget, impression-limit, and duplicate-view checks. |
| Ledger and withdrawals | Wallet balances, held balances, ledger entries, withdrawal quotes, account masking, reviewed withdrawal status transitions, and recorded payment references. |
| Administration | Operational metrics, payment and withdrawal queues, campaign creation, package rules, user status controls, fraud flags, platform settings, and audit logging. |
| Security | Firebase Auth-backed session access, role-gated procedures, server-side input validation, screenshot MIME/extension/size validation, private storage keys with owner/admin-only signed URLs, and relationship constraints. |

## Data Model and Migrations

The Drizzle schema resides in `drizzle/schema.ts`. Migration files are under `drizzle/`, including an additive constraint migration that establishes foreign-key references for critical user, package, campaign, and wallet relationships and a unique `(userId, campaignId)` protection for advertising views.

All monetary values are stored in **paisa** as integers. The ledger records balance effects with prior and resulting available and held balances. Member-facing formatting converts paisa to PKR only for display.

## Local Development

```bash
pnpm install
cp .env.example .env   # then fill in Firebase + B2 values (see below)
pnpm dev
```

Use the following quality checks before publishing:

```bash
pnpm check
pnpm test
pnpm build
```

## Firebase Migration

This branch migrates the platform off the Manus stack:

| Before (Manus) | After |
|---|---|
| MySQL via `DATABASE_URL` + Drizzle | Firestore (`asia-south1`) via the Firebase Admin SDK (`server/db.ts` keeps the same API, numeric IDs, and transactional ledger writes) |
| Manus OAuth member login | Firebase Authentication (Google): client signs in with the Firebase SDK, POSTs the ID token to `/api/auth/firebase`, the server verifies it and issues a first-party HS256 session cookie (`server/_core/session.ts`) |
| Local admin login via `sdk.createSessionToken` | Same `ADMIN_EMAIL` / `ADMIN_PASSWORD` login, now signing sessions with `server/_core/session.ts` — works independently of Firebase |
| Forge/S3 presigned uploads | Backblaze B2 private bucket (S3-compatible, free tier: 10 GB storage + 1 GB/day egress). Payment proofs stay private: short-lived presigned URLs minted server-side only after owner/admin authorization |

Setup (one time):

1. Copy `.env.example` to `.env` and fill in the server values.
2. Firebase Admin service account: Firebase console > Project settings >
   Service accounts > Generate new private key. Download it **yourself** and
   copy `project_id`, `client_email`, `private_key` into
   `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.
   The private key never goes through chat or the repo.
3. Backblaze B2: create a **private** bucket + application key, set
   `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_ENDPOINT`.
4. Client build: set the `VITE_FIREBASE_*` values from the Firebase web app
   config (public identifiers, safe to expose).
5. Deploy Firestore rules + indexes:
   `firebase deploy --only firestore:rules,firestore:indexes`
   (rules deny all direct client access — everything goes through the server).

## Deploying on Vercel

The repo is Vercel-ready (`vercel.json` + `api/index.ts` serverless entrypoint).
All persistent state lives outside the function: Firestore for data and
Backblaze B2 for files.

1. Push this repo to GitHub and import it in Vercel (**Add New → Project**).
2. Vercel auto-detects the build (`pnpm build`) and output directory
   (`dist/public`). No code changes needed.
3. Set these **Environment Variables** in the Vercel project settings
   (all environments). (`VITE_*` values are baked in at build time.)
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
     — Firebase Admin service account (the three fields live in the local
     `.env`; copy the same values into your hosting provider's environment
     variables for production — never commit them).
   - `JWT_SECRET` — secret used to sign session cookies.
   - `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_ENDPOINT` —
     private payment-proof storage via Backblaze B2.
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` — local administrator login, works
     independently of Firebase member login.
   - `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
     `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`,
     `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`,
     `VITE_FIREBASE_MEASUREMENT_ID` — public Firebase web config.
4. Deploy. Vercel's CDN serves the client; `/api/*` requests
   (`/api/trpc`, `/api/auth/firebase`, storage proxy) run as a serverless
   function. Sessions are stateless JWT cookies and uploads go to B2,
   so nothing depends on the function's ephemeral filesystem.


## Production Configuration Required

Before accepting real users or payments, an authorized administrator must replace all bracketed placeholders in the platform settings. At minimum, configure the company name, support contact details, JazzCash/Easypaisa/Bank payment information, account title, business hours, withdrawal minimum and fee, package terms, and the company’s legally reviewed terms, privacy, and refund policies.

The platform does **not** initiate external JazzCash, Easypaisa, bank, email, SMS, or WhatsApp transactions. Those integrations require separately authorized providers, credentials, legal review, operational reconciliation, and end-to-end testing.

## Operational Notes

> A payment screenshot never activates a membership on its own. An administrator must verify it. A withdrawal request places the requested balance on hold; an administrator must document either the paid reference or a reversal outcome.

Ad campaign rewards are determined by the server, rather than the browser. The system checks package status, campaign status and dates, duration, daily limits, campaign budget, impression limits, and duplicate campaign access before posting a reward. Suspicious patterns should be reviewed through fraud flags and account-review controls rather than through undocumented balance changes.

## Verification

The final build has passed TypeScript checks, production compilation, and Vitest coverage for logout behavior, financial validation, ad eligibility, payment-proof validation, Pakistan mobile validation, and administrator authorization. Public desktop and mobile views were also reviewed in the managed preview.
