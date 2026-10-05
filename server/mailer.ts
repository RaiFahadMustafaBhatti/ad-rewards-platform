import nodemailer from "nodemailer";

/**
 * SMTP mailer for transactional email (password resets).
 *
 * Configuration comes from environment variables:
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, SMTP_FROM
 *
 * When any required value is missing the mailer is disabled: sendMail logs a
 * warning and returns false instead of throwing, so the app keeps working and
 * callers can present an honest "not available" message.
 */

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS ?? "";
  if (!host || !user || !pass) return null;
  const port = Number(process.env.SMTP_PORT ?? "587") || 587;
  const from = process.env.SMTP_FROM?.trim() || user;
  return { host, port, user, pass, from };
}

export function isMailerConfigured(): boolean {
  return readSmtpConfig() !== null;
}

export async function sendMail(input: { to: string; subject: string; text: string; html?: string }): Promise<boolean> {
  const config = readSmtpConfig();
  if (!config) {
    console.warn("[Mailer] SMTP not configured; skipping email to", input.to);
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });
    await transporter.sendMail({ from: config.from, to: input.to, subject: input.subject, text: input.text, html: input.html });
    return true;
  } catch (error) {
    console.error("[Mailer] Failed to send email:", error instanceof Error ? error.message : error);
    return false;
  }
}

export function appBaseUrl(): string {
  return (process.env.APP_URL ?? "https://fmb-earning-hub.vercel.app").replace(/\/$/, "");
}
