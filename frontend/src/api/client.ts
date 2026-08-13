import axios from "axios";
import { ref } from "vue";

export const api = axios.create({ baseURL: "/api" });

export const requirePasswordChange = ref(false);

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * A 401 from the login or credential-change endpoints means "those details are wrong", not
 * "your session lapsed", so it is left for the form that asked to display. Sending them
 * through the redirect below would reload the page and throw the error away before it could
 * render, so a failed sign-in would just blank the form without saying why.
 */
function isCredentialCheck(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0];
  return (
    path.endsWith("/auth/login") ||
    path.endsWith("/auth/captcha") ||
    path.endsWith("/auth/credentials")
  );
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && !isCredentialCheck(error.config?.url)) {
      localStorage.removeItem("token");
      if (!window.location.pathname.startsWith("/login")) {
        window.location.replace("/login");
      }
    }
    return Promise.reject(error);
  },
);

/** Pulls a readable message out of an axios error, falling back to its own text. */
export function errorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { error?: string; details?: string } | undefined;
    if (data?.error) return data.details ? `${data.error}: ${data.details}` : data.error;
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

// ── Types mirroring the backend responses ─────────────────────────────────────

export type AccountView = {
  id: number;
  email: string;
  clientId: string;
  hasPassword: boolean;
  tokenHint: string;
  remark: string | null;
  disabled: boolean;
  lastRefreshAt: number | null;
  lastRefreshError: string | null;
  lastCopiedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type MailMessage = {
  send: string;
  subject: string;
  text: string;
  html: string;
  date: string;
  code?: string;
};

export type ApiKeyView = {
  id: number;
  name: string;
  keyPrefix: string;
  lastUsedAt: number | null;
  createdAt: number;
};

export type HealthView = {
  status: string;
  uptime: number;
  encryptionAtRest: boolean;
  aiConfigured: boolean;
};

export type Mailbox = "INBOX" | "Junk";

/** "copy" marks an address used as soon as it is copied; "mail" waits for mail after it. */
export type UsageMode = "copy" | "mail";

export type PanelSettings = {
  pollDurationMinutes: number;
  pollIntervalSeconds: number;
  usageMode: UsageMode;
  showClientId: boolean;
  showRefreshToken: boolean;
};

export const DEFAULT_PANEL_SETTINGS: PanelSettings = {
  pollDurationMinutes: 5,
  pollIntervalSeconds: 20,
  usageMode: "mail",
  showClientId: false,
  showRefreshToken: false,
};

// ── Calls ─────────────────────────────────────────────────────────────────────

export type CaptchaChallenge = { svg: string; captchaToken: string };

export async function fetchCaptcha() {
  const { data } = await api.get<CaptchaChallenge>("/auth/captcha");
  return data;
}

export async function login(
  username: string,
  password: string,
  captchaToken: string,
  captchaAnswer: string,
) {
  const { data } = await api.post<{ token: string; requirePasswordChange: boolean }>(
    "/auth/login",
    { username, password, captchaToken, captchaAnswer },
  );
  localStorage.setItem("token", data.token);
  requirePasswordChange.value = data.requirePasswordChange;
  return data;
}

export function logout(): void {
  localStorage.removeItem("token");
  window.location.replace("/login");
}

export async function fetchHealth() {
  const { data } = await api.get<HealthView>("/health");
  return data;
}

export async function fetchAccounts() {
  const { data } = await api.get<AccountView[]>("/accounts");
  return data;
}

export async function createAccount(input: {
  email: string;
  password?: string;
  clientId: string;
  refreshToken: string;
  remark?: string;
}) {
  const { data } = await api.post<AccountView>("/accounts", input);
  return data;
}

export async function updateAccount(
  id: number,
  patch: Partial<AccountView> & { refreshToken?: string; password?: string },
) {
  const { data } = await api.patch<AccountView>(`/accounts/${id}`, patch);
  return data;
}

export async function importAccounts(content: string, delimiter: string) {
  const { data } = await api.post<{
    imported: number;
    failed: number;
    errors: { line: number; reason: string }[];
  }>("/accounts/import", { content, delimiter });
  return data;
}

export async function deleteAccounts(ids: number[]) {
  const { data } = await api.post<{ deleted: number }>("/accounts/delete", { ids });
  return data;
}

/** Stamps the copy time, which is what the "used" column measures arrivals against. */
export async function markAccountCopied(id: number) {
  const { data } = await api.post<AccountView>(`/accounts/${id}/copied`);
  return data;
}

export type LatestMailView = {
  message: MailMessage | null;
  transport: "graph" | "imap";
  account: AccountView;
};

export async function fetchLatestMail(id: number) {
  const { data } = await api.get<LatestMailView>(`/accounts/${id}/latest-mail`);
  return data;
}

export async function refreshAccountTokens(ids?: number[]) {
  const { data } = await api.post<{
    total: number;
    succeeded: number;
    failed: number;
    results: { id: number; email: string; ok: boolean; error?: string }[];
  }>("/accounts/refresh", { ids: ids ?? [] });
  return data;
}

/**
 * Reads a folder.
 *
 * `shape=array` pins the response, because the compatibility endpoint otherwise mirrors
 * upstream and answers with a bare object on the IMAP path and an array on the Graph one.
 */
export async function fetchMail(email: string, mailbox: Mailbox, limit = 100) {
  const { data } = await api.get<MailMessage[]>("/mail-all", {
    params: { email, mailbox, limit, shape: "array" },
  });
  return Array.isArray(data) ? data : [];
}

export async function purgeMailbox(email: string, mailbox: Mailbox) {
  const path = mailbox === "Junk" ? "/process-junk" : "/process-inbox";
  const { data } = await api.post<{ message: string; deleted: number }>(path, { email });
  return data;
}

export async function fetchApiKeys() {
  const { data } = await api.get<ApiKeyView[]>("/api-keys");
  return data;
}

export async function createApiKeyRequest(name: string) {
  const { data } = await api.post<ApiKeyView & { key: string }>("/api-keys", { name });
  return data;
}

export async function deleteApiKeyRequest(id: number) {
  await api.delete(`/api-keys/${id}`);
}

export async function fetchPanelSettings() {
  const { data } = await api.get<PanelSettings>("/settings");
  return data;
}

export async function savePanelSettings(patch: Partial<PanelSettings>) {
  const { data } = await api.put<PanelSettings>("/settings", patch);
  return data;
}

export async function updateCredentials(input: {
  currentPassword: string;
  newPassword?: string;
  newUsername?: string;
}) {
  const { data } = await api.post<{ token: string }>("/auth/credentials", input);
  localStorage.setItem("token", data.token);
  requirePasswordChange.value = false;
  return data;
}
