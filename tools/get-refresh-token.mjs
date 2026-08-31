#!/usr/bin/env node
/**
 * Mints a refresh token for one mailbox, in the shape this project imports.
 *
 * Runs the authorisation-code flow with PKCE against a *public client* registration, which
 * is what the server assumes: its token exchange sends `client_id` and nothing else, so an
 * app that requires a client secret would be rejected on every refresh.
 *
 * Automatic mode, when the browser runs on this machine:
 *   node tools/get-refresh-token.mjs --client-id <guid> [--imap] [--email a@b.com]
 *
 * Manual mode, when it does not. Nothing listens on the redirect port; copy the `code` out
 * of the browser's address bar and redeem it in the second step:
 *   node tools/get-refresh-token.mjs --client-id <guid> --url
 *   node tools/get-refresh-token.mjs --client-id <guid> --code '<code>' --verifier '<v>'
 *
 *   --imap           Ask for the older Outlook IMAP/SMTP scopes instead of Graph
 *   --tenant         Authority segment, default "consumers" (personal Microsoft accounts)
 *   --port           Loopback port in the redirect URI, default 53682
 *   --redirect-uri   Use a registered URI other than the loopback default. Entra allows
 *                    plain http only on localhost, so anything else must be https.
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
const redirectUri =
  typeof args["redirect-uri"] === "string"
    ? args["redirect-uri"]
    : `http://localhost:${port}/callback`;
const redirect = new URL(redirectUri);
if (redirect.protocol === "http:" && !["localhost", "127.0.0.1"].includes(redirect.hostname)) {
  console.error(`Entra rejects plain http outside localhost. Use https for ${redirect.hostname}.`);
  process.exit(1);
}
const authority = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;

/** `scope` and `redirect_uri` must match the authorize request, so both steps rebuild them. */
function buildAuthorizeUrl(challenge, state) {
  return (
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
    }).toString()
  );
}

async function exchangeCode(code, verifier) {
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

/** Waits for Microsoft to redirect back, and hands over the one-time code. */
function waitForCode(authorizeUrl, state) {
  const listenPort = Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80));
  // A loopback URI is bound to loopback; anything else is reached through DNS or a proxy,
  // so it has to accept connections from off the box.
  const listenHost = ["localhost", "127.0.0.1"].includes(redirect.hostname)
    ? "127.0.0.1"
    : "0.0.0.0";
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== redirect.pathname) {
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
    server.listen(listenPort, listenHost, () => {
      console.log(
        `\nOpen this in a browser and sign in as the mailbox owner:\n\n${authorizeUrl}\n`,
      );
      console.log(`Listening on ${redirectUri} ...`);
    });
  });
}

function report(token) {
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
}

// Step two of manual mode: redeem a code copied out of the browser.
if (args.code) {
  const verifier = args.verifier ?? process.env.CODE_VERIFIER;
  if (typeof verifier !== "string") {
    console.error("Missing --verifier, the value printed alongside the URL by --url.");
    process.exit(1);
  }
  try {
    report(await exchangeCode(String(args.code).trim(), verifier.trim()));
  } catch (error) {
    console.error("\n" + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
} else {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const authorizeUrl = buildAuthorizeUrl(challenge, state);

  // Step one of manual mode: print the pair and stop, so the verifier survives this process.
  if (args.url) {
    console.log("\nOpen this in a browser and sign in as the mailbox owner:\n");
    console.log(authorizeUrl);
    console.log("\nThe browser will fail to load the redirect. That is fine -- copy the");
    console.log("`code=` value out of its address bar (stop at the `&state=`), then run:\n");
    console.log(
      `node tools/get-refresh-token.mjs --client-id ${clientId}` +
        (args.imap ? " --imap" : "") +
        (args.port ? ` --port ${port}` : "") +
        (typeof args["redirect-uri"] === "string" ? ` --redirect-uri '${redirectUri}'` : "") +
        (args.email && args.email !== true ? ` --email ${args.email}` : "") +
        ` \\\n  --verifier '${verifier}' \\\n  --code 'PASTE_THE_CODE_HERE'`,
    );
    console.log("\nSingle quotes matter: a code can contain ! and * characters.");
    console.log("The code expires in about 10 minutes and is good for one attempt.\n");
  } else {
    try {
      report(await exchangeCode(await waitForCode(authorizeUrl, state), verifier));
    } catch (error) {
      console.error("\n" + (error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  }
}
