import { getSetting, setSetting } from "./database";
import {
  clampPriority,
  parseOauthPriorityMode,
  parseVerifyRules,
  type OauthPriorityMode,
  type VerifyRule,
} from "../types";

/**
 * Panel preferences.
 *
 * Server-side rather than in the browser because they change behaviour the server owns --
 * how a used address is decided -- and because an operator who signs in from a second
 * machine should not have to set them again.
 */
export type PanelSettings = {
  /** How long the panel keeps polling a mailbox after its address is copied. */
  pollDurationMinutes: number;
  pollIntervalSeconds: number;
  /** How long an address handed to an integration stays claimed without a code arriving. */
  leaseMinutes: number;
  /** "copy" marks an address used the moment it is copied; "mail" waits for mail after it. */
  usageMode: UsageMode;
  showClientId: boolean;
  showRefreshToken: boolean;
  /**
   * Defaults for the "connect mailbox" OAuth flow, so an operator sets the app registration
   * once instead of on every account. Empty means "not configured", and the environment
   * variables OAUTH_CLIENT_ID / OAUTH_REDIRECT_URI are consulted next.
   */
  oauthClientId: string;
  oauthRedirectUri: string;
  /** Where an account connected through the OAuth callback lands in the pool queue. */
  oauthPriorityMode: OauthPriorityMode;
  /** The rank used when the mode is "fixed"; ignored otherwise. */
  oauthPriorityValue: number;
  /**
   * Refresh a token this many days after its last successful refresh. Zero turns the sweep
   * off entirely, which is the default: a panel that has not asked for it should not be
   * talking to Microsoft on a timer.
   */
  autoRefreshMaxDays: number;
  /** Local time of day the sweep runs, `HH:MM`. */
  autoRefreshAt: string;
  /**
   * Priority bands to re-check, each with its own interval. Empty turns the check off, which
   * is the default -- like the refresh sweep, a panel that has not asked for it should not be
   * talking to Microsoft on a timer.
   */
  verifyRules: VerifyRule[];
  /** Local time of day the verification runs, `HH:MM`. */
  verifyAt: string;
};

export type UsageMode = "copy" | "mail";

export const DEFAULT_PANEL_SETTINGS: PanelSettings = {
  pollDurationMinutes: 5,
  pollIntervalSeconds: 20,
  leaseMinutes: 15,
  usageMode: "mail",
  showClientId: false,
  showRefreshToken: false,
  oauthClientId: "",
  oauthRedirectUri: "",
  oauthPriorityMode: "normal",
  oauthPriorityValue: 0,
  autoRefreshMaxDays: 0,
  autoRefreshAt: "04:00",
  verifyRules: [],
  // An hour after the refresh sweep's default, so the two are not queued at the token
  // endpoint together on an install that turns both on and changes neither time.
  verifyAt: "05:00",
};

const KEYS = {
  pollDurationMinutes: "panel.poll_duration_minutes",
  pollIntervalSeconds: "panel.poll_interval_seconds",
  leaseMinutes: "panel.lease_minutes",
  usageMode: "panel.usage_mode",
  showClientId: "panel.show_client_id",
  showRefreshToken: "panel.show_refresh_token",
  oauthClientId: "panel.oauth_client_id",
  oauthRedirectUri: "panel.oauth_redirect_uri",
  oauthPriorityMode: "panel.oauth_priority_mode",
  oauthPriorityValue: "panel.oauth_priority_value",
  autoRefreshMaxDays: "panel.auto_refresh_max_days",
  autoRefreshAt: "panel.auto_refresh_at",
  /** The local date (YYYY-MM-DD) the sweep last ran, so a restart cannot repeat it. */
  autoRefreshLastRun: "panel.auto_refresh_last_run",
  verifyRules: "panel.verify_rules",
  verifyAt: "panel.verify_at",
  verifyLastRun: "panel.verify_last_run",
} as const;

/** Bounds exist so a typo cannot set a one-second poll hammering Microsoft for an hour. */
export const LIMITS = {
  pollDurationMinutes: { min: 1, max: 60 },
  pollIntervalSeconds: { min: 5, max: 600 },
  leaseMinutes: { min: 1, max: 1440 },
  // Zero is the off switch, so this one is not clamped up to its minimum like the others.
  autoRefreshMaxDays: { min: 0, max: 365 },
} as const;

/** `HH:MM` on a 24-hour clock, or null when it is not a time at all. */
export function parseTimeOfDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function clamp(value: number, { min, max }: { min: number; max: number }): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readNumber(key: string, fallback: number, bounds: { min: number; max: number }): number {
  const raw = Number(getSetting(key));
  return Number.isFinite(raw) && raw > 0 ? clamp(raw, bounds) : fallback;
}

function readString(key: string, fallback: string): string {
  const raw = getSetting(key);
  return typeof raw === "string" ? raw : fallback;
}

function readDays(key: string, fallback: number): number {
  const raw = Number(getSetting(key));
  return Number.isFinite(raw) && raw >= 0 ? clamp(raw, LIMITS.autoRefreshMaxDays) : fallback;
}

function readPriority(key: string, fallback: number): number {
  const raw = Number(getSetting(key));
  return Number.isFinite(raw) ? clampPriority(Math.trunc(raw)) : fallback;
}

/**
 * The rules as stored: one JSON array in one key.
 *
 * A list of rows does not fit the flat key/value settings table without either a column of
 * numbered keys or a table of its own, and neither is worth it for a handful of rows nothing
 * else joins against. Unreadable JSON reads as "no rules" rather than throwing, so one bad
 * write cannot take the settings page down with it.
 */
function readVerifyRules(): VerifyRule[] {
  const raw = getSetting(KEYS.verifyRules);
  if (!raw) return [];
  try {
    return parseVerifyRules(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

function readBoolean(key: string, fallback: boolean): boolean {
  const raw = getSetting(key);
  return raw === undefined ? fallback : raw === "true";
}

export function getPanelSettings(): PanelSettings {
  const mode = getSetting(KEYS.usageMode);
  return {
    pollDurationMinutes: readNumber(
      KEYS.pollDurationMinutes,
      DEFAULT_PANEL_SETTINGS.pollDurationMinutes,
      LIMITS.pollDurationMinutes,
    ),
    pollIntervalSeconds: readNumber(
      KEYS.pollIntervalSeconds,
      DEFAULT_PANEL_SETTINGS.pollIntervalSeconds,
      LIMITS.pollIntervalSeconds,
    ),
    leaseMinutes: readNumber(
      KEYS.leaseMinutes,
      DEFAULT_PANEL_SETTINGS.leaseMinutes,
      LIMITS.leaseMinutes,
    ),
    usageMode: mode === "copy" || mode === "mail" ? mode : DEFAULT_PANEL_SETTINGS.usageMode,
    showClientId: readBoolean(KEYS.showClientId, DEFAULT_PANEL_SETTINGS.showClientId),
    showRefreshToken: readBoolean(KEYS.showRefreshToken, DEFAULT_PANEL_SETTINGS.showRefreshToken),
    oauthClientId: readString(KEYS.oauthClientId, DEFAULT_PANEL_SETTINGS.oauthClientId),
    oauthRedirectUri: readString(KEYS.oauthRedirectUri, DEFAULT_PANEL_SETTINGS.oauthRedirectUri),
    oauthPriorityMode:
      parseOauthPriorityMode(getSetting(KEYS.oauthPriorityMode)) ??
      DEFAULT_PANEL_SETTINGS.oauthPriorityMode,
    // Not readNumber: a priority is legitimately zero or negative, which that rejects.
    oauthPriorityValue: readPriority(
      KEYS.oauthPriorityValue,
      DEFAULT_PANEL_SETTINGS.oauthPriorityValue,
    ),
    // Not readNumber: zero is the off switch, and that treats zero as "unset".
    autoRefreshMaxDays: readDays(
      KEYS.autoRefreshMaxDays,
      DEFAULT_PANEL_SETTINGS.autoRefreshMaxDays,
    ),
    autoRefreshAt:
      parseTimeOfDay(getSetting(KEYS.autoRefreshAt)) ?? DEFAULT_PANEL_SETTINGS.autoRefreshAt,
    verifyRules: readVerifyRules(),
    verifyAt: parseTimeOfDay(getSetting(KEYS.verifyAt)) ?? DEFAULT_PANEL_SETTINGS.verifyAt,
  };
}

/** Applies whichever fields were supplied, ignoring anything unrecognised or out of range. */
export function savePanelSettings(patch: Partial<PanelSettings>): PanelSettings {
  if (typeof patch.pollDurationMinutes === "number" && Number.isFinite(patch.pollDurationMinutes)) {
    setSetting(
      KEYS.pollDurationMinutes,
      String(clamp(patch.pollDurationMinutes, LIMITS.pollDurationMinutes)),
    );
  }
  if (typeof patch.pollIntervalSeconds === "number" && Number.isFinite(patch.pollIntervalSeconds)) {
    setSetting(
      KEYS.pollIntervalSeconds,
      String(clamp(patch.pollIntervalSeconds, LIMITS.pollIntervalSeconds)),
    );
  }
  if (typeof patch.leaseMinutes === "number" && Number.isFinite(patch.leaseMinutes)) {
    setSetting(KEYS.leaseMinutes, String(clamp(patch.leaseMinutes, LIMITS.leaseMinutes)));
  }
  if (patch.usageMode === "copy" || patch.usageMode === "mail") {
    setSetting(KEYS.usageMode, patch.usageMode);
  }
  if (typeof patch.showClientId === "boolean") {
    setSetting(KEYS.showClientId, String(patch.showClientId));
  }
  if (typeof patch.showRefreshToken === "boolean") {
    setSetting(KEYS.showRefreshToken, String(patch.showRefreshToken));
  }
  // Trimmed rather than validated here: an empty string is how the field is cleared, and
  // the OAuth route is what decides whether a value is usable.
  if (typeof patch.oauthClientId === "string") {
    setSetting(KEYS.oauthClientId, patch.oauthClientId.trim());
  }
  if (typeof patch.oauthRedirectUri === "string") {
    setSetting(KEYS.oauthRedirectUri, patch.oauthRedirectUri.trim());
  }
  if (typeof patch.autoRefreshMaxDays === "number" && Number.isFinite(patch.autoRefreshMaxDays)) {
    setSetting(
      KEYS.autoRefreshMaxDays,
      String(clamp(Math.max(0, patch.autoRefreshMaxDays), LIMITS.autoRefreshMaxDays)),
    );
  }
  const at = parseTimeOfDay(patch.autoRefreshAt);
  if (at) setSetting(KEYS.autoRefreshAt, at);
  // An empty array is a real value here -- it is how the check is turned off -- so the list
  // is written whenever one was supplied at all.
  const rules = parseVerifyRules(patch.verifyRules);
  if (rules) setSetting(KEYS.verifyRules, JSON.stringify(rules));
  const verifyAt = parseTimeOfDay(patch.verifyAt);
  if (verifyAt) setSetting(KEYS.verifyAt, verifyAt);
  const mode = parseOauthPriorityMode(patch.oauthPriorityMode);
  if (mode) setSetting(KEYS.oauthPriorityMode, mode);
  if (typeof patch.oauthPriorityValue === "number" && Number.isFinite(patch.oauthPriorityValue)) {
    setSetting(
      KEYS.oauthPriorityValue,
      String(clampPriority(Math.trunc(patch.oauthPriorityValue))),
    );
  }
  return getPanelSettings();
}

/** The local date the sweep last ran, as `YYYY-MM-DD`, or "" when it never has. */
export function getAutoRefreshLastRun(): string {
  return getSetting(KEYS.autoRefreshLastRun) ?? "";
}

export function setAutoRefreshLastRun(date: string): void {
  setSetting(KEYS.autoRefreshLastRun, date);
}

/** The local date the verification last ran, as `YYYY-MM-DD`, or "" when it never has. */
export function getVerifyLastRun(): string {
  return getSetting(KEYS.verifyLastRun) ?? "";
}

export function setVerifyLastRun(date: string): void {
  setSetting(KEYS.verifyLastRun, date);
}
