import { createHash, randomBytes } from "node:crypto";

/**
 * Holds the in-flight authorisation-code flows, keyed by the `state` handed to Microsoft.
 *
 * The PKCE verifier is the reason this exists. It is generated when the flow starts and is
 * needed again when the browser comes back, and it must never travel to the browser in
 * between: a verifier the client holds is a verifier an attacker who intercepts the
 * redirect also holds, which is precisely what PKCE exists to prevent.
 *
 * A flow is good for one callback. Left replayable, a leaked state would let someone else's
 * code be redeemed against this panel and stored as one of our accounts.
 */

export type PendingFlow = {
  email: string;
  clientId: string;
  authType: "auto" | "imap";
  /** Echoed verbatim into the token request, which must match the authorize request. */
  redirectUri: string;
  scope: string;
  verifier: string;
  expiresAt: number;
};

/** Long enough for a sign-in with MFA, short enough that an abandoned flow does not linger. */
const TTL_MS = 20 * 60_000;

const MAX_FLOWS = 100;

const flows = new Map<string, PendingFlow>();

function sweep(): void {
  const now = Date.now();
  for (const [state, flow] of flows) {
    if (flow.expiresAt <= now) flows.delete(state);
  }
  // Map iterates in insertion order, so the first key is always the oldest.
  while (flows.size >= MAX_FLOWS) {
    const oldest = flows.keys().next();
    if (oldest.done) break;
    flows.delete(oldest.value);
  }
}

export type StartedFlow = { state: string; challenge: string; expiresAt: number };

/** Stores a flow and returns the state and PKCE challenge the authorize URL carries. */
export function startFlow(input: Omit<PendingFlow, "verifier" | "expiresAt">): StartedFlow {
  sweep();
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + TTL_MS;
  flows.set(state, { ...input, verifier, expiresAt });
  return {
    state,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    expiresAt,
  };
}

/**
 * Takes a flow and burns it, whether or not it was still valid. An unknown, expired or
 * already-used state is indistinguishable from the caller's side.
 */
export function consumeFlow(state: string | undefined): PendingFlow | null {
  if (!state) return null;
  const flow = flows.get(state);
  flows.delete(state);
  if (!flow || flow.expiresAt <= Date.now()) return null;
  return flow;
}

/** Test hook: drops every outstanding flow. */
export function resetFlows(): void {
  flows.clear();
}

/** Test hook: how many flows are outstanding. */
export function flowCount(): number {
  return flows.size;
}
