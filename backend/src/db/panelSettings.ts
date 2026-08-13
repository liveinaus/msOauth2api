import { getSetting, setSetting } from "./database";

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
};

export type UsageMode = "copy" | "mail";

export const DEFAULT_PANEL_SETTINGS: PanelSettings = {
  pollDurationMinutes: 5,
  pollIntervalSeconds: 20,
  leaseMinutes: 15,
  usageMode: "mail",
  showClientId: false,
  showRefreshToken: false,
};

const KEYS = {
  pollDurationMinutes: "panel.poll_duration_minutes",
  pollIntervalSeconds: "panel.poll_interval_seconds",
  leaseMinutes: "panel.lease_minutes",
  usageMode: "panel.usage_mode",
  showClientId: "panel.show_client_id",
  showRefreshToken: "panel.show_refresh_token",
} as const;

/** Bounds exist so a typo cannot set a one-second poll hammering Microsoft for an hour. */
export const LIMITS = {
  pollDurationMinutes: { min: 1, max: 60 },
  pollIntervalSeconds: { min: 5, max: 600 },
  leaseMinutes: { min: 1, max: 1440 },
} as const;

function clamp(value: number, { min, max }: { min: number; max: number }): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readNumber(key: string, fallback: number, bounds: { min: number; max: number }): number {
  const raw = Number(getSetting(key));
  return Number.isFinite(raw) && raw > 0 ? clamp(raw, bounds) : fallback;
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
  return getPanelSettings();
}
