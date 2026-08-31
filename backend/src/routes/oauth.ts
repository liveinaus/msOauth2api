import { Router } from "express";
import rateLimit from "express-rate-limit";

import { consumeFlow, startFlow } from "../auth/oauthFlowStore";
import { clearRefreshError, upsertAccount } from "../db/accounts";
import { getPanelSettings } from "../db/panelSettings";
import { requireAuth } from "../middleware/auth";
import { noteAccountSuccess } from "../services/accountHealth";
import {
  AUTHORIZE_ENDPOINT,
  consentScopeFor,
  emailFromIdToken,
  exchangeAuthorizationCode,
  OAuthError,
} from "../services/oauth";
import { parseAuthType } from "../types";

const router = Router();

/**
 * The callback cannot carry a panel session -- the browser arrives on a redirect from
 * Microsoft, and this project keeps its session token in localStorage rather than a cookie.
 * What guards it is the `state`: unguessable, issued only to an authenticated caller of
 * /start, and burnt on first use. The limiter is belt and braces against someone hammering
 * the endpoint with guesses.
 */
const callbackLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many callback attempts. Try again later." },
});

/**
 * The app registration to run the flow against, most specific source first: what the caller
 * asked for, then the panel setting, then the environment. The callback never has to work
 * this out again -- the redirect carries only `code` and `state`, and the client id is read
 * back off the stored flow.
 */
function resolveClientId(supplied: unknown): string | null {
  if (typeof supplied === "string" && supplied.trim()) return supplied.trim();
  const stored = getPanelSettings().oauthClientId;
  if (stored) return stored;
  return process.env.OAUTH_CLIENT_ID?.trim() || null;
}

/**
 * Where Microsoft is told to send the browser back to.
 *
 * Same precedence, and it has to match a URI registered on the app registration character
 * for character. The last resort is the request's own host, which keeps a plain localhost
 * install working with no configuration at all; reading the Host header is safe here
 * because Entra refuses any redirect URI that was not registered.
 */
function resolveRedirectUri(supplied: unknown, protocol: string, host: string | undefined): string {
  if (typeof supplied === "string" && supplied.trim()) return supplied.trim();
  const stored = getPanelSettings().oauthRedirectUri;
  if (stored) return stored;
  const fromEnv = process.env.OAUTH_REDIRECT_URI?.trim();
  if (fromEnv) return fromEnv;
  return `${protocol}://${host ?? "localhost:3000"}/api/oauth/callback`;
}

/** Entra permits plain http only on loopback, so reject the rest before Microsoft does. */
function redirectUriProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "redirectUri must be an absolute URL";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) return null;
  return "redirectUri must use https, unless the host is localhost";
}

router.post("/start", requireAuth, (req, res) => {
  const { email, clientId, authType, redirectUri } = req.body ?? {};

  if (typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "email is required" });
    return;
  }

  const resolvedClientId = resolveClientId(clientId);
  if (!resolvedClientId) {
    res.status(400).json({
      error:
        "No client id. Set a default under Settings, or pass clientId, or set OAUTH_CLIENT_ID.",
    });
    return;
  }

  if (authType !== undefined && parseAuthType(authType) === null) {
    res.status(400).json({ error: "authType must be one of: auto, imap" });
    return;
  }
  const resolvedAuthType = parseAuthType(authType) ?? "auto";

  const resolvedRedirectUri = resolveRedirectUri(redirectUri, req.protocol, req.get("host"));

  const problem = redirectUriProblem(resolvedRedirectUri);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  const scope = consentScopeFor(resolvedAuthType);
  const { state, challenge, expiresAt } = startFlow({
    email: email.trim().toLowerCase(),
    clientId: resolvedClientId,
    authType: resolvedAuthType,
    redirectUri: resolvedRedirectUri,
    scope,
  });

  const authorizeUrl =
    `${AUTHORIZE_ENDPOINT}?` +
    new URLSearchParams({
      client_id: resolvedClientId,
      response_type: "code",
      redirect_uri: resolvedRedirectUri,
      response_mode: "query",
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      // Pre-fills the address, and prompts rather than silently reusing whichever account
      // the browser is already signed into.
      login_hint: email.trim(),
      prompt: "select_account",
    }).toString();

  res.json({ authorizeUrl, state, expiresAt, redirectUri: resolvedRedirectUri });
});

/**
 * What /start would use right now, so the operator can check it against the app
 * registration without starting a flow. The client id is not a secret -- it travels in
 * every authorize URL -- but it is only served to an authenticated panel session.
 */
router.get("/config", requireAuth, (req, res) => {
  const resolvedClientId = resolveClientId(undefined);
  res.json({
    configured: Boolean(resolvedClientId),
    clientId: resolvedClientId,
    redirectUri: resolveRedirectUri(undefined, req.protocol, req.get("host")),
  });
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The callback is read by a person in a browser, so it answers with a page, not JSON. */
function page(res: import("express").Response, status: number, title: string, body: string): void {
  res
    .status(status)
    .type("html")
    .send(
      `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; margin: 0; display: grid; place-items: center;
         min-height: 100vh; background: #f6f7f9; color: #1c2024; }
  .card { background: #fff; padding: 32px 36px; border-radius: 10px; max-width: 34rem;
          box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  h1 { font-size: 1.15rem; margin: 0 0 .6rem; }
  code { background: #f0f1f3; padding: .1rem .3rem; border-radius: 3px; word-break: break-all; }
  .ok { color: #17803d; } .bad { color: #b42318; }
</style></head>
<body><div class="card">${body}</div></body></html>`,
    );
}

router.get("/callback", callbackLimiter, async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (typeof error === "string") {
    page(
      res,
      400,
      "Sign-in failed",
      `<h1 class="bad">Sign-in was not completed</h1>
       <p>Microsoft returned <code>${escapeHtml(error)}</code>.</p>
       <p>${escapeHtml(typeof errorDescription === "string" ? errorDescription : "")}</p>
       <p>Nothing was saved. Start the flow again from the panel.</p>`,
    );
    return;
  }

  // Burnt here, before the exchange, so a code that fails cannot be replayed against a
  // still-live flow.
  const flow = consumeFlow(typeof state === "string" ? state : undefined);
  if (!flow) {
    page(
      res,
      400,
      "Link expired",
      `<h1 class="bad">This link is no longer valid</h1>
       <p>The sign-in was started too long ago, has already been used, or did not come from
       this panel. Nothing was saved.</p>
       <p>Start the flow again from the panel.</p>`,
    );
    return;
  }

  if (typeof code !== "string" || !code) {
    page(
      res,
      400,
      "No code",
      `<h1 class="bad">The redirect carried no code</h1><p>Nothing was saved.</p>`,
    );
    return;
  }

  let token;
  try {
    token = await exchangeAuthorizationCode({
      code,
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
      verifier: flow.verifier,
      scope: flow.scope,
    });
  } catch (caught) {
    const detail =
      caught instanceof OAuthError
        ? caught.details
        : caught instanceof Error
          ? caught.message
          : String(caught);
    console.error("[oauth] code exchange failed:", detail);
    page(
      res,
      502,
      "Exchange failed",
      `<h1 class="bad">Microsoft rejected the code</h1>
       <p><code>${escapeHtml(detail.slice(0, 600))}</code></p>
       <p>Nothing was saved. A code is single-use and lasts about ten minutes, so start the
       flow again rather than reloading this page.</p>`,
    );
    return;
  }

  /**
   * Guards against storing the wrong mailbox's token. The panel was told which address it
   * was connecting, but the browser signs in whoever it likes -- an admin already signed
   * into another account would otherwise have that account's token filed under the address
   * they typed, and every later read would silently hit the wrong mailbox.
   */
  const signedIn = emailFromIdToken(token.idToken);
  if (signedIn && signedIn.toLowerCase() !== flow.email) {
    page(
      res,
      409,
      "Wrong account",
      `<h1 class="bad">That is a different mailbox</h1>
       <p>The panel was connecting <code>${escapeHtml(flow.email)}</code> but the browser
       signed in as <code>${escapeHtml(signedIn)}</code>.</p>
       <p>Nothing was saved. Sign out of Microsoft, or use a private window, and start the
       flow again.</p>`,
    );
    return;
  }

  // Non-null: exchangeAuthorizationCode rejects a response without a refresh token.
  const account = upsertAccount({
    email: flow.email,
    clientId: flow.clientId,
    refreshToken: token.refreshToken!,
    authType: flow.authType,
  });
  // A freshly consented token supersedes whatever went wrong before, so the row should not
  // keep a stale warning badge that would hold it out of the address pool.
  clearRefreshError(account.id);
  noteAccountSuccess(account.id);

  console.log(`[oauth] stored refresh token for ${account.email} (account ${account.id})`);
  page(
    res,
    200,
    "Mailbox connected",
    `<h1 class="ok">Mailbox connected</h1>
     <p><code>${escapeHtml(account.email)}</code> is saved and ready to use. No import needed.</p>
     <p>Granted scope: <code>${escapeHtml(token.scope || "(none reported)")}</code></p>
     <p>You can close this tab and refresh the Accounts page.</p>`,
  );
});

export default router;
