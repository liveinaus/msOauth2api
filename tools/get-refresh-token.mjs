#!/usr/bin/env node
/**
 * Mints a refresh token for one mailbox, in the shape this project imports.
 *
 * Runs the authorisation-code flow with PKCE against a *public client* registration, which
 * is what the server assumes: its token exchange sends `client_id` and nothing else, so an
 * app that requires a client secret would be rejected on every refresh.
 *
 * Usage:
 *   node tools/get-refresh-token.mjs --client-id <guid> [--imap] [--email a@b.com]
 *
 *   --imap      Ask for the older Outlook IMAP/SMTP scopes instead of Graph
 *   --tenant    Authority segment, default "consumers" (personal Microsoft accounts)
 *   --port      Loopback port for the redirect, default 53682
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const GRAPH_SCOPES = [
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
  "offline_access",
];

const IMAP_SCOPES = [
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
  "offline_access",
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const clientId = args["client-id"] ?? process.env.CLIENT_ID;
if (!clientId) {
  console.error("Missing --client-id (or CLIENT_ID in the environment).");
  process.exit(1);
}

const tenant = args.tenant ?? "consumers";
const port = Number(args.port ?? 53682);
const scopes = (args.imap ? IMAP_SCOPES : GRAPH_SCOPES).join(" ");
const redirectUri = `http://localhost:${port}/callback`;
const authority = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const authorizeUrl =
  `${authority}/authorize?` +
  new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();

/** Waits for Microsoft to redirect back, and hands over the one-time code. */
function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(error ? `Failed: ${error}` : "Done. Back to the terminal.");
      server.close();

      if (error) reject(new Error(`${error}: ${url.searchParams.get("error_description")}`));
      else if (returnedState !== state) reject(new Error("State mismatch, ignoring response."));
      else if (!code) reject(new Error("Redirect carried no code."));
      else resolve(code);
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(
        `\nOpen this in a browser and sign in as the mailbox owner:\n\n${authorizeUrl}\n`,
      );
      console.log(`Listening on ${redirectUri} ...`);
    });
  });
}

async function exchangeCode(code) {
  const response = await fetch(`${authority}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: scopes,
    }).toString(),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Token endpoint returned ${response.status}: ${raw}`);
  return JSON.parse(raw);
}

let token;
try {
  token = await exchangeCode(await waitForCode());
} catch (error) {
  console.error("\n" + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}

if (!token.refresh_token) {
  console.error("No refresh_token came back. Was offline_access consented?");
  process.exit(1);
}

console.log("\nGranted scope:", token.scope);
console.log("\nrefresh_token:\n" + token.refresh_token);
console.log("\nImport line (replace PASSWORD, or leave it as a placeholder):\n");
console.log(
  [args.email ?? "EMAIL", "PASSWORD", clientId, token.refresh_token]
    .concat(args.imap ? ["imap"] : [])
    .join("----"),
);
