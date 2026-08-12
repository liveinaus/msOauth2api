import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { getTokenEpoch, verifyApiKey } from "../auth/credentials";

const KNOWN_DEFAULT_SECRETS = new Set(["change-me-in-production", "changeme", "secret"]);

export const TOKEN_TTL = "7d";

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error("FATAL: JWT_SECRET is not set. Set it before starting msOauth2api.");
    process.exit(1);
  }
  if (KNOWN_DEFAULT_SECRETS.has(secret.trim())) {
    console.error(
      "FATAL: JWT_SECRET is a publicly known default. Generate a unique secret, e.g. `openssl rand -hex 32`.",
    );
    process.exit(1);
  }
  return secret;
}

export type SessionTokenPayload = {
  sub: string;
  /** Epoch the token was signed under; anything older has been revoked. */
  ep: number;
  requirePasswordChange?: boolean;
};

export function signSession(payload: Omit<SessionTokenPayload, "ep">): string {
  return jwt.sign({ ...payload, ep: getTokenEpoch() }, getJwtSecret(), { expiresIn: TOKEN_TTL });
}

/** Guards the panel's own routes. The browser sends a bearer token from localStorage. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const payload = jwt.verify(token, getJwtSecret()) as SessionTokenPayload;
    const epoch = getTokenEpoch();
    // Zero means no epoch has ever been set, so accept anything until the first
    // credential change moves it.
    if (epoch !== 0 && (payload.ep ?? 0) < epoch) {
      res.status(401).json({ error: "Session revoked" });
      return;
    }
    (req as Request & { session?: SessionTokenPayload }).session = payload;
    next();
  } catch {
    res.status(401).json({ error: "Not authenticated" });
  }
}

/** Constant-time string compare that tolerates differing lengths. */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Pulls the presented machine credential out of a request.
 *
 * `X-API-Key` (or a bearer header) is the way to send it. The `password` query/body
 * parameter is upstream's contract and is still read, so scripts written against the
 * Vercel version keep working -- at the cost of putting the secret in every access log,
 * which is why the header is documented as the preferred form.
 */
function presentedCredential(req: Request): string {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header) return header;

  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);

  const source = (req.method === "GET" ? req.query : req.body) ?? {};
  const supplied = (source as Record<string, unknown>).password;
  return typeof supplied === "string" ? supplied : "";
}

/**
 * Guards the machine-facing mail endpoints.
 *
 * Accepts, in order: a panel session token, a real API key, or the legacy shared PASSWORD.
 * Unlike upstream, an unset PASSWORD does not make these endpoints public -- a container
 * with a mailbox database in it should never answer an unauthenticated caller, and
 * upstream's `password !== expected && expected` idiom did exactly that.
 */
export async function requireApiAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const presented = presentedCredential(req);
  if (!presented) {
    res.status(401).json({ error: "Missing credential. Send X-API-Key or ?password=" });
    return;
  }

  const legacy = process.env.PASSWORD;
  if (legacy && secretEquals(presented, legacy)) {
    next();
    return;
  }

  // A session token lets the SPA call these endpoints without minting itself a key.
  try {
    const payload = jwt.verify(presented, getJwtSecret()) as SessionTokenPayload;
    const epoch = getTokenEpoch();
    if (epoch === 0 || (payload.ep ?? 0) >= epoch) {
      next();
      return;
    }
  } catch {
    // Not a session token, so fall through to the API key check.
  }

  if (await verifyApiKey(presented)) {
    next();
    return;
  }

  res.status(401).json({ error: "Invalid credential" });
}

/**
 * Guards /api/send-mail. SEND_PASSWORD is upstream's separate secret for sending; when it
 * is unset this falls back to the normal API credential rather than allowing anyone
 * through, so an unconfigured install cannot be used as an open relay.
 */
export async function requireSendAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const configured = process.env.SEND_PASSWORD;
  if (configured) {
    const source = (req.method === "GET" ? req.query : req.body) ?? {};
    const supplied = (source as Record<string, unknown>).send_password;
    const headerKey = req.headers["x-api-key"];
    const presented =
      typeof supplied === "string" && supplied
        ? supplied
        : typeof headerKey === "string"
          ? headerKey
          : "";

    if (secretEquals(presented, configured)) {
      next();
      return;
    }
  }

  await requireApiAccess(req, res, next);
}
