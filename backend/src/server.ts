import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";

import { initCredentials } from "./auth/credentials";
import { caseDuplicateEmails, reencryptAll } from "./db/accounts";
import { encryptionEnabled } from "./db/crypto";
import { dbFilePath } from "./db/database";
import { getJwtSecret } from "./middleware/auth";
import { startAccountVerify } from "./services/accountVerify";
import { startAutoRefresh } from "./services/autoRefresh";
import accountsRouter from "./routes/accounts";
import aiRouter from "./routes/ai";
import apiKeysRouter from "./routes/apikeys";
import authRouter from "./routes/auth";
import backupRouter from "./routes/backup";
import healthRouter from "./routes/health";
import integrationRouter from "./routes/integration";
import mailRouter from "./routes/mail";
import oauthRouter from "./routes/oauth";
import settingsRouter from "./routes/settings";
import typesRouter from "./routes/types";

// Fail fast on a missing or placeholder secret, before anything is served.
getJwtSecret();

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const BIND_HOST = process.env.HOST ?? "0.0.0.0";

// TRUST_PROXY: the number of proxy hops in front of this app.
// 0/false = direct internet, so clients cannot spoof X-Forwarded-For
// 1       = one reverse proxy (nginx, Caddy, Traefik)
// 2+      = several (e.g. Cloudflare + nginx)
// The login rate limiter keys on the client IP, so getting this wrong either lets one
// attacker rotate identities or lumps every visitor into a single bucket.
const trustProxy = process.env.TRUST_PROXY ?? "0";
app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

/**
 * CORS. The SPA is served same-origin in production and needs no headers at all; the
 * defaults cover the Vite dev server.
 *
 * The mail endpoints deliberately allow any origin: they are a machine API guarded by a
 * key, callers are scripts and other servers rather than browsers, and upstream set
 * `Access-Control-Allow-Origin: *` on /api/* which existing integrations may rely on.
 * Credentials are never reflected, so this cannot be used to ride a panel session.
 */
const configuredOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const panelOrigins = configuredOrigins.length
  ? configuredOrigins
  : ["http://localhost:5173", "http://127.0.0.1:5173"];

const MACHINE_ROUTES = new Set([
  "/api/mail-new",
  "/api/mail-all",
  "/api/refresh-token",
  "/api/process-inbox",
  "/api/process-junk",
  "/api/send-mail",
  "/api/delete-mail",
  "/api/get-available-email",
  "/api/get-code",
  "/api/get-link",
  "/api/confirm-email",
  "/api/release-email",
  "/api/email-status",
  "/api/pool-status",
]);

app.use(
  cors((req, callback) => {
    if (MACHINE_ROUTES.has(req.path)) {
      callback(null, { origin: "*", credentials: false });
      return;
    }
    callback(null, { origin: panelOrigins });
  }),
);

// A whole-system backup is orders of magnitude larger than any other body, and express.json
// skips a request another parser has already read, so this only widens the one route.
app.use("/api/backup", express.json({ limit: "128mb" }));
app.use(express.json({ limit: "5mb" }));
// Upstream's callers commonly POST form-encoded bodies, so both parsers are mounted.
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

/**
 * Baseline security headers, kept dependency-free.
 *
 * The CSP matters here specifically because the panel renders message HTML from untrusted
 * senders. That content is shown in a sandboxed iframe, and `script-src 'self'` means even
 * a mistake in that isolation cannot run an attacker's script against the origin holding
 * the session token.
 */
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      // Message bodies are rendered in a sandboxed, srcdoc iframe.
      "frame-src 'self' blob:",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
  );
  next();
});

// Each panel router is mounted on its own prefix rather than bare "/api". A router that
// calls router.use(requireAuth) applies it to every request reaching its mount point, not
// only to paths it defines, so mounting these at "/api" made the accounts guard answer the
// machine endpoints and the 404 handler below with "Not authenticated".
app.use("/api", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/api-keys", apiKeysRouter);
app.use("/api/backup", backupRouter);
app.use("/api/oauth", oauthRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/types", typesRouter);
app.use("/api", mailRouter);
app.use("/api", integrationRouter);
app.use("/api", aiRouter);

// Anything under /api that got this far does not exist. Without this the SPA fallback
// below would answer a mistyped endpoint with index.html and a 200.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ── Static SPA ────────────────────────────────────────────────────────────────
// The Dockerfile copies the built frontend here. In dev this directory does not exist and
// Vite serves the panel instead, so its absence is not an error.
const publicDir = path.resolve(__dirname, "../public");
if (fs.existsSync(publicDir)) {
  app.use(
    express.static(publicDir, {
      // Vite fingerprints asset filenames, so they can be cached hard; index.html must not
      // be, or a browser keeps loading the previous build's asset names after an upgrade.
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "max-age=31536000, immutable");
        }
      },
    }),
  );

  app.get("*", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

/**
 * Last line of defence against one mailbox taking the panel with it.
 *
 * The panel serves dozens of accounts and a stray fault on any one of them -- a socket reset
 * mid-fetch, a library emitting on a path with no listener -- would otherwise end the
 * process by Node's default and stop the other ninety-nine working. Logged loudly and kept
 * running instead: nothing here shares mutable state across requests, so a failed request is
 * contained. The container healthcheck still catches a process that is genuinely wedged.
 */
function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[fatal-guard] unhandled rejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[fatal-guard] uncaught exception:", error);
  });
}

async function main(): Promise<void> {
  installProcessGuards();
  await initCredentials();

  // Left from before addresses were normalised: the same mailbox as two rows, which the pool
  // would hand out twice with only one of them holding a live token.
  for (const group of caseDuplicateEmails()) {
    console.warn(
      `[db] these addresses differ only in case and are the same mailbox: ${group.join(", ")}. ` +
        "Delete the stale row; the pool treats them as two accounts.",
    );
  }

  if (encryptionEnabled()) {
    const changed = reencryptAll();
    if (changed > 0) console.log(`[db] encrypted secrets for ${changed} account(s) at rest`);
  } else {
    console.warn(
      "[db] MSAPI_DATA_KEY is not set: refresh tokens are stored as plain text. See env.example.",
    );
  }

  startAutoRefresh();
  startAccountVerify();

  app.listen(PORT, BIND_HOST, () => {
    console.log(`msOauth2api listening on http://${BIND_HOST}:${PORT}`);
    console.log(`[db] ${dbFilePath()}`);
  });
}

main().catch((error) => {
  console.error("FATAL: failed to start", error);
  process.exit(1);
});
