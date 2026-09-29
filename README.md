# FMB Earning Hub — Advertising Rewards Platform

## Purpose

FMB Earning Hub is a full-stack advertising rewards and digital membership application. It is designed as a **verified advertising participation service**, not as an investment product. The public interface and member flows explicitly avoid profit, return, passive-income, or guaranteed-earning claims.

## Implemented Scope

| Area | Included implementation |
|---|---|
| Public experience | Responsive landing page, package comparison, process explanation, FAQ, contact placeholders, and policy/disclosure routes. |
| Memberships | Configurable Platinum, Gold, and Diamond package records with editable price, eligible-ad reward, daily limit, duration, and availability. |
| Payment verification | Authenticated manual proof submission with image validation, transaction-ID uniqueness, S3 storage keys, approval/rejection flow, notifications, and audit entries. |
| Ad campaigns | Administrator campaign creation; protected member sessions; server-side duration, eligibility, daily-limit, campaign-budget, impression-limit, and duplicate-view checks. |
| Ledger and withdrawals | Wallet balances, held balances, ledger entries, withdrawal quotes, account masking, reviewed withdrawal status transitions, and recorded payment references. |
| Administration | Operational metrics, payment and withdrawal queues, campaign creation, package rules, user status controls, fraud flags, platform settings, and audit logging. |
| Security | OAuth-backed session access, role-gated procedures, server-side input validation, screenshot MIME/extension/size validation, secure storage-key access, and relationship constraints. |

## Data Model and Migrations

The Drizzle schema resides in `drizzle/schema.ts`. Migration files are under `drizzle/`, including an additive constraint migration that establishes foreign-key references for critical user, package, campaign, and wallet relationships and a unique `(userId, campaignId)` protection for advertising views.

All monetary values are stored in **paisa** as integers. The ledger records balance effects with prior and resulting available and held balances. Member-facing formatting converts paisa to PKR only for display.

## Local Development

```bash
pnpm install
pnpm drizzle-kit migrate
pnpm dev
```

Use the following quality checks before publishing:

```bash
pnpm check
pnpm test
pnpm build
```

## Deploying on Vercel

The repo is Vercel-ready (`vercel.json` + `api/index.ts` serverless entrypoint).
The database stays on the Manus MySQL host — only the app code moves to Vercel.

1. Push this repo to GitHub and import it in Vercel (**Add New → Project**).
2. Vercel auto-detects the build (`pnpm build`) and output directory
   (`dist/public`). No code changes needed.
3. Set these **Environment Variables** in the Vercel project settings
   (all environments):
   - `DATABASE_URL` — the Manus MySQL connection string (kept as-is;
     all accounts, wallets, and ledger data stay there).
   - `JWT_SECRET` — secret used to sign session cookies (must match the
     value the Manus deployment used, otherwise existing sessions expire).
   - `BUILT_IN_FORGE_API_URL` / `BUILT_IN_FORGE_API_KEY` — file uploads
     (payment proofs) via S3 presigned URLs.
   - `OAUTH_SERVER_URL`, `OWNER_OPEN_ID`, `VITE_APP_ID`,
     `VITE_OAUTH_PORTAL_URL`, `VITE_FRONTEND_FORGE_API_URL`,
     `VITE_FRONTEND_FORGE_API_KEY` — copy from the Manus deployment.
     (`VITE_*` values are baked in at build time.)
   - Local admin login (email + password via `ADMIN_EMAIL` / `ADMIN_PASSWORD`)
     keeps working even if Manus OAuth is unreachable from Vercel.
4. Deploy. Vercel's CDN serves the client; `/api/*` requests
   (`/api/trpc`, `/api/oauth/*`, storage proxy) run as a serverless
   function. Sessions are stateless JWT cookies and uploads go to S3,
   so nothing depends on the function's ephemeral filesystem.

> If the Manus MySQL host restricts connections to the Manus network,
> allowlist Vercel's IPs or move the database — otherwise the function
> cannot reach it.


## Production Configuration Required

Before accepting real users or payments, an authorized administrator must replace all bracketed placeholders in the platform settings. At minimum, configure the company name, support contact details, JazzCash/Easypaisa/Bank payment information, account title, business hours, withdrawal minimum and fee, package terms, and the company’s legally reviewed terms, privacy, and refund policies.

The platform does **not** initiate external JazzCash, Easypaisa, bank, email, SMS, or WhatsApp transactions. Those integrations require separately authorized providers, credentials, legal review, operational reconciliation, and end-to-end testing.

## Operational Notes

> A payment screenshot never activates a membership on its own. An administrator must verify it. A withdrawal request places the requested balance on hold; an administrator must document either the paid reference or a reversal outcome.

Ad campaign rewards are determined by the server, rather than the browser. The system checks package status, campaign status and dates, duration, daily limits, campaign budget, impression limits, and duplicate campaign access before posting a reward. Suspicious patterns should be reviewed through fraud flags and account-review controls rather than through undocumented balance changes.

## Verification

The final build has passed TypeScript checks, production compilation, and Vitest coverage for logout behavior, financial validation, ad eligibility, payment-proof validation, Pakistan mobile validation, and administrator authorization. Public desktop and mobile views were also reviewed in the managed preview.
