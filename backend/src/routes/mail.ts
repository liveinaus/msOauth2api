import { Router } from "express";
import type { Request, Response } from "express";
import { getAccountByEmail, recordRefresh } from "../db/accounts";
import { requireApiAccess, requireSendAccess } from "../middleware/auth";
import { exchangeRefreshToken, getMailAccessToken, OAuthError } from "../services/oauth";
import { purgeMail, readMail } from "../services/mail";
import { sendMail } from "../services/smtp";
import { noteUsage } from "../services/usage";
import type { Mailbox, MailMessage } from "../types";
import { ParamError, parseLimit, parseMailbox, readParams, resolveCredentials } from "./params";

const router = Router();

const MAIL_ALL_DEFAULT = 100;
const MAIL_ALL_MAX = 1000;

/**
 * Persists a rolled refresh token against the stored account, if this address is one.
 *
 * Microsoft invalidates the old token when it issues a new one, so an install that did not
 * write the replacement back would work exactly once per account and then start failing.
 * Upstream had nowhere to store it; here it is the difference between a panel that keeps
 * working and one that goes stale overnight.
 */
function persistRotation(email: string, rotated: string | null): void {
  if (!rotated) return;
  const stored = getAccountByEmail(email);
  if (stored) recordRefresh(stored.id, rotated, null);
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ParamError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof OAuthError) {
    // Pass Microsoft's own status through: a 400 here almost always means the refresh
    // token has expired, which the caller needs to tell apart from a server fault.
    res.status(error.status).json({ error: "Refresh token failed", details: error.details });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error("[mail]", error);
  res.status(500).json({ error: message });
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Upstream's HTML view, with every caller-controlled field escaped. */
function renderHtml(mail: MailMessage): string {
  const text = escapeHtml(mail.text).replace(/\n/g, "<br>");
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; line-height: 1.6; margin: 0; padding: 20px; background-color: #f9f9f9;">
    <div style="margin: 0 auto; background: #fff; padding: 20px; border: 1px solid #ddd; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
      <h1 style="color: #333;">Message</h1>
      <p><strong>From:</strong> ${escapeHtml(mail.send)}</p>
      <p><strong>Subject:</strong> ${escapeHtml(mail.subject)}</p>
      <p><strong>Date:</strong> ${escapeHtml(mail.date)}</p>
      ${mail.code ? `<p><strong>Code:</strong> ${escapeHtml(mail.code)}</p>` : ""}
      <div style="background: #f4f4f4; padding: 10px; border: 1px solid #ddd;">
        <p><strong>Body:</strong></p>
        <p>${text}</p>
      </div>
    </div>
  </body>
</html>`;
}

/**
 * Latest message in a folder.
 *
 * Response shape is upstream's, quirk included: the Graph path answered with an array of
 * one and the IMAP path with a bare object, so both are reproduced by transport rather
 * than normalised, and a client written against either keeps working. Pass
 * `shape=object|array` to pin it and stop caring which transport served the request.
 */
router.get("/mail-new", requireApiAccess, handleMailNew);
router.post("/mail-new", requireApiAccess, handleMailNew);

async function handleMailNew(req: Request, res: Response): Promise<void> {
  try {
    const params = readParams(req);
    const mailbox = parseMailbox(params.mailbox);
    if (!mailbox) {
      res.status(400).json({ error: "Invalid mailbox. Allowed: INBOX, Junk" });
      return;
    }

    const credentials = resolveCredentials(params);
    const result = await readMail(credentials, mailbox, 1);
    persistRotation(credentials.email, result.rotatedRefreshToken);
    noteUsage(credentials.email, result.messages);

    const latest = result.messages[0];

    if (params.response_type === "html") {
      if (!latest) {
        res.status(404).send("<!doctype html><html><body><p>No messages.</p></body></html>");
        return;
      }
      res.status(200).type("html").send(renderHtml(latest));
      return;
    }
    if (params.response_type && params.response_type !== "json") {
      res.status(400).json({ error: 'Invalid response_type. Use "json" or "html".' });
      return;
    }

    const shape = params.shape ?? (result.transport === "graph" ? "array" : "object");
    if (shape === "array") {
      res.status(200).json(result.messages);
      return;
    }
    res.status(200).json(latest ?? null);
  } catch (error) {
    sendError(res, error);
  }
}

/** Every message in a folder, newest first. */
router.get("/mail-all", requireApiAccess, handleMailAll);
router.post("/mail-all", requireApiAccess, handleMailAll);

async function handleMailAll(req: Request, res: Response): Promise<void> {
  try {
    const params = readParams(req);
    const mailbox = parseMailbox(params.mailbox);
    if (!mailbox) {
      res.status(400).json({ error: "Invalid mailbox. Allowed: INBOX, Junk" });
      return;
    }

    const credentials = resolveCredentials(params);
    // Upstream asked Graph for $top=10000 and fetched every IMAP message in the folder,
    // which is a timeout on a large mailbox. Bounded by default, overridable with `limit`.
    const limit = parseLimit(params.limit, MAIL_ALL_DEFAULT, MAIL_ALL_MAX);

    const result = await readMail(credentials, mailbox, limit);
    persistRotation(credentials.email, result.rotatedRefreshToken);
    noteUsage(credentials.email, result.messages);

    res.status(200).json(result.messages);
  } catch (error) {
    sendError(res, error);
  }
}

/** Exchanges a refresh token for its replacement. */
router.get("/refresh-token", requireApiAccess, handleRefreshToken);
router.post("/refresh-token", requireApiAccess, handleRefreshToken);

async function handleRefreshToken(req: Request, res: Response): Promise<void> {
  try {
    const params = readParams(req);
    // Upstream took only refresh_token and client_id here, with no address at all.
    const credentials = resolveCredentials(params, { requireEmail: false });

    const token = await exchangeRefreshToken(credentials.refreshToken, credentials.clientId);
    persistRotation(credentials.email, token.refreshToken);

    // Upstream echoed the supplied token when the response carried no replacement, so a
    // caller could always store what came back.
    res.status(200).json({ refresh_token: token.refreshToken ?? credentials.refreshToken });
  } catch (error) {
    const params = readParams(req);
    const stored = params.email ? getAccountByEmail(params.email) : undefined;
    if (stored && error instanceof OAuthError) {
      recordRefresh(stored.id, null, error.details.slice(0, 500));
    }
    sendError(res, error);
  }
}

function purgeHandler(mailbox: Mailbox) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const credentials = resolveCredentials(readParams(req));
      const result = await purgeMail(credentials, mailbox);
      persistRotation(credentials.email, result.rotatedRefreshToken);

      res.status(200).json({
        message:
          result.deleted === 0 ? `No ${mailbox} emails found.` : "Emails processed successfully.",
        deleted: result.deleted,
        transport: result.transport,
      });
    } catch (error) {
      sendError(res, error);
    }
  };
}

router.get("/process-inbox", requireApiAccess, purgeHandler("INBOX"));
router.post("/process-inbox", requireApiAccess, purgeHandler("INBOX"));
router.get("/process-junk", requireApiAccess, purgeHandler("Junk"));
router.post("/process-junk", requireApiAccess, purgeHandler("Junk"));

/** Sends a message as the account, over Outlook SMTP. */
router.get("/send-mail", requireSendAccess, handleSendMail);
router.post("/send-mail", requireSendAccess, handleSendMail);

async function handleSendMail(req: Request, res: Response): Promise<void> {
  try {
    const params = readParams(req);
    const { to, subject, text, html } = params;
    if (!to || !subject || (!text && !html)) {
      res.status(400).json({ error: "Missing required parameters: to, subject, and text or html" });
      return;
    }

    const credentials = resolveCredentials(params);
    const token = await getMailAccessToken(credentials.refreshToken, credentials.clientId);
    persistRotation(credentials.email, token.refreshToken);

    const info = await sendMail({
      email: credentials.email,
      clientId: credentials.clientId,
      accessToken: token.accessToken,
      to,
      subject,
      text,
      html,
    });

    res.status(200).json({ message: "Email sent successfully", messageId: info.messageId });
  } catch (error) {
    sendError(res, error);
  }
}

export default router;
