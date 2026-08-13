<template>
  <div>
    <div class="page-header">
      <span class="page-title">{{ t("accounts.title") }}</span>
      <div class="btn-row">
        <input v-model="search" class="form-input" style="width: 200px" :placeholder="t('common.search')" />
        <button class="btn" @click="showImport = true">
          <i class="fa-solid fa-file-import"></i> {{ t("accounts.import") }}
        </button>
        <button class="btn" @click="exportAccounts">
          <i class="fa-solid fa-file-export"></i> {{ t("accounts.export") }}
        </button>
        <button class="btn" @click="showAdd = true">
          <i class="fa-solid fa-plus"></i> {{ t("accounts.addOne") }}
        </button>
        <button class="btn" :disabled="refreshing" @click="refreshTokens">
          <i class="fa-solid fa-rotate"></i>
          {{ refreshing ? t("accounts.refreshing") : t("accounts.refreshTokens") }}
        </button>
        <button class="btn btn-danger" :disabled="!selected.size" @click="confirmDelete">
          <i class="fa-solid fa-trash"></i> {{ t("accounts.deleteSelected") }}
        </button>
      </div>
    </div>

    <div v-if="notice" class="alert alert-ok">{{ notice }}</div>
    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="checkbox-cell">
              <input type="checkbox" :checked="allVisibleSelected" @change="toggleAll" />
            </th>
            <th>{{ t("accounts.email") }}</th>
            <th>{{ t("accounts.code") }}</th>
            <th v-if="panel.showClientId">{{ t("accounts.clientId") }}</th>
            <th v-if="panel.showRefreshToken">{{ t("accounts.token") }}</th>
            <th>{{ t("accounts.status") }}</th>
            <th>{{ t("accounts.lastRefresh") }}</th>
            <th>{{ t("accounts.lastUsed") }}</th>
            <th>{{ t("common.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="account in pageItems" :key="account.id">
            <td class="checkbox-cell">
              <input type="checkbox" :checked="selected.has(account.id)" @change="toggle(account.id)" />
            </td>
            <td>
              <div class="email-cell">
                <span class="clickable" :title="t('accounts.copyEmail')" @click="copyEmail(account)">
                  {{ account.email }}
                </span>
                <button class="btn btn-sm" :title="t('accounts.copyEmail')" @click="copyEmail(account)">
                  <i :class="copiedId === account.id ? 'fa-solid fa-check' : 'fa-regular fa-copy'"></i>
                </button>
              </div>
            </td>
            <td class="code-cell" @mouseenter="showPreview(account.id, $event)" @mouseleave="hidePreview">
              <template v-if="codeFor(account.id)">
                <span
                  class="code-chip clickable"
                  :title="t('accounts.codeHover')"
                  @click="openCached(account)"
                >
                  {{ codeFor(account.id) }}
                </span>
                <button
                  class="btn btn-sm"
                  :title="t('accounts.copyCode')"
                  @click="copyCode(account.id, codeFor(account.id)!)"
                >
                  <i :class="codeCopiedId === account.id ? 'fa-solid fa-check' : 'fa-regular fa-copy'"></i>
                </button>
                <i
                  v-if="isPolling(account.id)"
                  class="fa-solid fa-circle-notch fa-spin muted"
                  :title="countdown(account.id)"
                ></i>
              </template>
              <span v-else-if="isPolling(account.id)" class="muted">
                <i class="fa-solid fa-circle-notch fa-spin"></i> {{ countdown(account.id) }}
              </span>
              <span v-else class="muted">—</span>
            </td>
            <td v-if="panel.showClientId" class="mono">{{ account.clientId }}</td>
            <td v-if="panel.showRefreshToken" class="mono" :title="t('accounts.tokenHidden')">
              {{ account.tokenHint }}
            </td>
            <td>
              <span v-if="account.disabled" class="badge badge-off">{{ t("accounts.disabled") }}</span>
              <span
                v-else-if="account.lastRefreshError"
                class="badge badge-err"
                :title="account.lastRefreshError"
              >
                <i class="fa-solid fa-triangle-exclamation"></i>
              </span>
              <span v-else class="badge badge-ok">{{ t("accounts.enabled") }}</span>
            </td>
            <td>{{ formatTime(account.lastRefreshAt) }}</td>
            <td>
              <span v-if="account.lastUsedAt">{{ formatTime(account.lastUsedAt) }}</span>
              <span v-else-if="account.lastCopiedAt" class="muted" :title="t('accounts.usePending')">
                {{ t("accounts.copiedAt", { time: formatTime(account.lastCopiedAt) }) }}
              </span>
              <span v-else class="muted">{{ t("common.never") }}</span>
            </td>
            <td>
              <div class="btn-row">
                <button
                  class="btn btn-sm"
                  :title="t('accounts.latestMail')"
                  :disabled="latestBusyId === account.id"
                  @click="openLatest(account)"
                >
                  <i
                    :class="
                      latestBusyId === account.id
                        ? 'fa-solid fa-circle-notch fa-spin'
                        : 'fa-regular fa-envelope-open'
                    "
                  ></i>
                </button>
                <button class="btn btn-sm" :title="t('accounts.viewMail')" @click="openMail(account)">
                  <i class="fa-solid fa-inbox"></i>
                </button>
                <button
                  class="btn btn-sm"
                  :title="account.disabled ? t('accounts.enable') : t('accounts.disable')"
                  @click="toggleDisabled(account)"
                >
                  <i :class="account.disabled ? 'fa-solid fa-play' : 'fa-solid fa-pause'"></i>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="!loading && filtered.length === 0" class="empty-state">
        {{ accounts.length === 0 ? t("accounts.empty") : t("common.none") }}
      </div>
      <div v-if="loading" class="empty-state">{{ t("common.loading") }}</div>
    </div>

    <PaginationBar v-model:page="page" v-model:page-size="pageSize" :total="filtered.length" />

    <!--
      Teleported and fixed-position: the table scrolls horizontally, so a popover living
      inside the cell would be clipped by that overflow on a narrow window.
    -->
    <Teleport to="body">
      <div
        v-if="preview"
        class="code-popover"
        :style="{ top: `${preview.top}px`, left: `${preview.left}px` }"
      >
        <div class="code-popover-head">{{ preview.subject || "(no subject)" }}</div>
        <div class="code-popover-meta">{{ preview.send }} · {{ preview.date }}</div>
        <div class="code-popover-body">{{ preview.text }}</div>
      </div>
    </Teleport>

    <!-- Latest email -->
    <div v-if="showLatest" class="modal-overlay" @click.self="closeLatest">
      <div class="modal modal-lg">
        <div class="modal-header">
          <span>{{ latestMail?.subject || t("accounts.latestMail") }}</span>
          <button class="modal-close" @click="closeLatest">&times;</button>
        </div>
        <div class="modal-body">
          <div v-if="latestError" class="alert alert-error">{{ latestError }}</div>
          <template v-else-if="latestMail">
            <div class="mail-meta">
              <div>
                <strong>{{ t("accounts.email") }}:</strong> {{ latestEmail }}
              </div>
              <div>
                <strong>{{ t("mail.from") }}:</strong> {{ latestMail.send }}
              </div>
              <div>
                <strong>{{ t("mail.date") }}:</strong> {{ formatMailDate(latestMail.date) }}
              </div>
              <div v-if="latestMail.code">
                <strong>{{ t("mail.code") }}:</strong>
                <span class="code-chip">{{ latestMail.code }}</span>
                <button
                  class="btn btn-sm"
                  style="margin-left: 8px"
                  :title="t('common.copy')"
                  @click="copyModalCode(latestMail.code)"
                >
                  <i class="fa-regular fa-copy"></i>
                  {{ codeCopied ? t("common.copied") : t("common.copy") }}
                </button>
              </div>
            </div>

            <!-- Sandboxed exactly as the mailbox view does: no scripts, no same-origin. -->
            <iframe
              v-if="latestFrameUrl"
              class="mail-frame"
              sandbox=""
              :src="latestFrameUrl"
              referrerpolicy="no-referrer"
            ></iframe>
            <div v-else class="mail-text">{{ latestMail.text || "(empty)" }}</div>
          </template>
          <div v-else class="empty-state">{{ t("mail.empty") }}</div>
        </div>
        <div class="modal-footer">
          <button class="btn" @click="openMailFromLatest">
            <i class="fa-solid fa-inbox"></i> {{ t("accounts.viewMail") }}
          </button>
          <button class="btn" @click="closeLatest">{{ t("common.close") }}</button>
        </div>
      </div>
    </div>

    <!-- Import -->
    <div v-if="showImport" class="modal-overlay" @click.self="showImport = false">
      <div class="modal">
        <div class="modal-header">
          {{ t("accounts.importTitle") }}
          <button class="modal-close" @click="showImport = false">&times;</button>
        </div>
        <div class="modal-body">
          <p class="hint">{{ t("accounts.importHint") }}</p>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.importDelimiter") }}</label>
            <input v-model="delimiter" class="form-input" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.importPaste") }}</label>
            <textarea v-model="importText" class="form-textarea" spellcheck="false"></textarea>
          </div>
          <input type="file" accept=".txt,.csv,text/plain" @change="loadFile" />
          <div v-if="importErrors.length" class="alert alert-warn" style="margin-top: 12px">
            <div v-for="e in importErrors" :key="e.line">line {{ e.line }}: {{ e.reason }}</div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" @click="showImport = false">{{ t("common.cancel") }}</button>
          <button class="btn btn-primary" :disabled="importing" @click="runImport">
            {{ importing ? t("common.saving") : t("accounts.import") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Add one -->
    <div v-if="showAdd" class="modal-overlay" @click.self="showAdd = false">
      <div class="modal">
        <div class="modal-header">
          {{ t("accounts.addOne") }}
          <button class="modal-close" @click="showAdd = false">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">{{ t("accounts.email") }}</label>
            <input v-model="draft.email" class="form-input" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.clientId") }}</label>
            <input v-model="draft.clientId" class="form-input" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.token") }}</label>
            <input v-model="draft.refreshToken" class="form-input" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("accounts.remark") }}</label>
            <input v-model="draft.remark" class="form-input" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" @click="showAdd = false">{{ t("common.cancel") }}</button>
          <button class="btn btn-primary" @click="addAccount">{{ t("common.save") }}</button>
        </div>
      </div>
    </div>

    <!-- Delete confirmation -->
    <div v-if="showDelete" class="modal-overlay" @click.self="showDelete = false">
      <div class="modal" style="max-width: 400px">
        <div class="modal-header">{{ t("accounts.deleteSelected") }}</div>
        <div class="modal-body">{{ t("accounts.deleteConfirm", { n: selected.size }) }}</div>
        <div class="modal-footer">
          <button class="btn" @click="showDelete = false">{{ t("common.cancel") }}</button>
          <button class="btn btn-danger" @click="runDelete">{{ t("common.delete") }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import PaginationBar from "../components/PaginationBar.vue";
import {
  api,
  createAccount,
  deleteAccounts,
  errorMessage,
  fetchAccounts,
  fetchPanelSettings,
  importAccounts,
  markAccountCopied,
  refreshAccountTokens,
  updateAccount,
  DEFAULT_PANEL_SETTINGS,
  type AccountView,
  type MailMessage,
  type PanelSettings,
} from "../api/client";
import { t } from "../i18n";
import { copyText } from "../utils/clipboard";
import {
  clock,
  isPolling,
  latestFor,
  onAccountUpdate,
  pollDeadline,
  refreshLatest,
  startPolling,
} from "../stores/latestMail";

const router = useRouter();

const accounts = ref<AccountView[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const importing = ref(false);
const error = ref("");
const notice = ref("");

const search = ref("");
const page = ref(1);
const pageSize = ref(25);
const selected = ref(new Set<number>());

const panel = ref<PanelSettings>({ ...DEFAULT_PANEL_SETTINGS });

const copiedId = ref<number | null>(null);
const codeCopiedId = ref<number | null>(null);
const preview = ref<{
  top: number;
  left: number;
  subject: string;
  send: string;
  date: string;
  text: string;
} | null>(null);
const latestBusyId = ref<number | null>(null);
const showLatest = ref(false);
const latestMail = ref<MailMessage | null>(null);
const latestEmail = ref("");
const latestError = ref("");
const latestFrameUrl = ref("");
const codeCopied = ref(false);

const showImport = ref(false);
const showAdd = ref(false);
const showDelete = ref(false);
const delimiter = ref("----");
const importText = ref("");
const importErrors = ref<{ line: number; reason: string }[]>([]);
const draft = ref({ email: "", clientId: "", refreshToken: "", remark: "" });

const filtered = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (!term) return accounts.value;
  return accounts.value.filter(
    (a) =>
      a.email.toLowerCase().includes(term) ||
      a.clientId.toLowerCase().includes(term) ||
      (a.remark ?? "").toLowerCase().includes(term),
  );
});

const pageItems = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return filtered.value.slice(start, start + pageSize.value);
});

const allVisibleSelected = computed(
  () => pageItems.value.length > 0 && pageItems.value.every((a) => selected.value.has(a.id)),
);

// A filter or page-size change can leave the view past the last page, which renders as an
// empty table with rows that do exist.
watch([filtered, pageSize], () => {
  const maxPage = Math.max(1, Math.ceil(filtered.value.length / pageSize.value));
  if (page.value > maxPage) page.value = maxPage;
});

function flash(message: string): void {
  notice.value = message;
  window.setTimeout(() => (notice.value = ""), 4000);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    accounts.value = await fetchAccounts();
  } catch (err) {
    error.value = errorMessage(err, "Could not load accounts");
  } finally {
    loading.value = false;
  }
}

let unsubscribe: (() => void) | null = null;

onMounted(async () => {
  // Polls started before you navigated away keep running, so the table adopts whatever they
  // have brought back since.
  unsubscribe = onAccountUpdate(replaceAccount);
  await load();
  try {
    panel.value = await fetchPanelSettings();
  } catch {
    // The defaults are the shipped ones, so a failure here only costs custom poll timings.
  }
});

onUnmounted(() => {
  unsubscribe?.();
  revokeLatestFrame();
});

function toggle(id: number): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleAll(): void {
  const next = new Set(selected.value);
  if (allVisibleSelected.value) pageItems.value.forEach((a) => next.delete(a.id));
  else pageItems.value.forEach((a) => next.add(a.id));
  selected.value = next;
}

function openMail(account: AccountView): void {
  router.push({ name: "mail", params: { email: account.email } });
}

/** Replaces one row in place, so a single account's dates refresh without a full reload. */
function replaceAccount(updated: AccountView): void {
  const index = accounts.value.findIndex((a) => a.id === updated.id);
  if (index !== -1) accounts.value[index] = updated;
}

/**
 * Copying is what starts the usage window, so the timestamp is only recorded once the text
 * is actually on the clipboard -- a failed copy means the address went nowhere.
 *
 * The copy also starts the short poll: an address is normally copied straight into a signup
 * form, and the code that follows is what you came for.
 */
async function copyEmail(account: AccountView): Promise<void> {
  if (!(await copyText(account.email))) {
    error.value = t("accounts.copyFailed");
    return;
  }

  copiedId.value = account.id;
  window.setTimeout(() => {
    if (copiedId.value === account.id) copiedId.value = null;
  }, 2000);

  try {
    const updated = await markAccountCopied(account.id);
    replaceAccount(updated);
    startPolling(account.id, {
      durationMs: panel.value.pollDurationMinutes * 60_000,
      intervalMs: panel.value.pollIntervalSeconds * 1000,
      // The server's copy time, so the "did this arrive after the copy?" test is not
      // decided by whatever this browser's clock happens to say.
      since: updated.lastCopiedAt ?? Date.now(),
    });
  } catch (err) {
    error.value = errorMessage(err, "Could not record the copy");
  }
}

function codeFor(id: number): string | undefined {
  return latestFor(id)?.message?.code;
}

function countdown(id: number): string {
  const deadline = pollDeadline(id);
  if (deadline === null) return "";
  const seconds = Math.max(0, Math.round((deadline - clock.value) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function copyCode(id: number, code: string): Promise<void> {
  if (!(await copyText(code))) {
    error.value = t("accounts.copyFailed");
    return;
  }
  codeCopiedId.value = id;
  window.setTimeout(() => {
    if (codeCopiedId.value === id) codeCopiedId.value = null;
  }, 2000);
}

/** Plain-text preview of a message, HTML stripped, for the hover panel. */
function previewText(message: MailMessage): string {
  const raw = message.text?.trim() || message.html.replace(/<[^>]+>/g, " ");
  return raw.replace(/\s+/g, " ").slice(0, 600);
}

function showPreview(id: number, event: MouseEvent): void {
  const message = latestFor(id)?.message;
  if (!message) return;

  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const WIDTH = 360;
  preview.value = {
    top: Math.min(rect.bottom + 8, window.innerHeight - 40),
    left: Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8)),
    subject: message.subject,
    send: message.send,
    date: formatMailDate(message.date),
    text: previewText(message),
  };
}

function hidePreview(): void {
  preview.value = null;
}

/** Opens the message already in hand, without spending another mailbox round trip. */
function openCached(account: AccountView): void {
  const entry = latestFor(account.id);
  if (!entry?.message) {
    void openLatest(account);
    return;
  }
  hidePreview();
  latestEmail.value = account.email;
  latestError.value = "";
  showMessage(entry.message);
}

function showMessage(message: MailMessage): void {
  revokeLatestFrame();
  latestMail.value = message;
  if (message.html) {
    const blob = new Blob([message.html], { type: "text/html" });
    latestFrameUrl.value = URL.createObjectURL(blob);
  }
  showLatest.value = true;
}

async function openLatest(account: AccountView): Promise<void> {
  latestBusyId.value = account.id;
  latestEmail.value = account.email;
  latestError.value = "";
  latestMail.value = null;
  revokeLatestFrame();

  await refreshLatest(account.id);
  const entry = latestFor(account.id);

  latestBusyId.value = null;
  latestError.value = entry?.error ?? "";
  if (entry?.message) showMessage(entry.message);
  else showLatest.value = true;
}

function revokeLatestFrame(): void {
  if (latestFrameUrl.value) {
    URL.revokeObjectURL(latestFrameUrl.value);
    latestFrameUrl.value = "";
  }
}

function closeLatest(): void {
  showLatest.value = false;
  latestMail.value = null;
  codeCopied.value = false;
  revokeLatestFrame();
}

function openMailFromLatest(): void {
  const email = latestEmail.value;
  closeLatest();
  router.push({ name: "mail", params: { email } });
}

async function copyModalCode(code: string): Promise<void> {
  if (!(await copyText(code))) return;
  codeCopied.value = true;
  window.setTimeout(() => (codeCopied.value = false), 2000);
}

async function toggleDisabled(account: AccountView): Promise<void> {
  try {
    await updateAccount(account.id, { disabled: !account.disabled });
    await load();
  } catch (err) {
    error.value = errorMessage(err, "Could not update account");
  }
}

async function addAccount(): Promise<void> {
  error.value = "";
  try {
    await createAccount({
      email: draft.value.email.trim(),
      clientId: draft.value.clientId.trim(),
      refreshToken: draft.value.refreshToken.trim(),
      remark: draft.value.remark.trim() || undefined,
    });
    showAdd.value = false;
    draft.value = { email: "", clientId: "", refreshToken: "", remark: "" };
    await load();
  } catch (err) {
    error.value = errorMessage(err, "Could not add account");
  }
}

function loadFile(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => (importText.value = String(reader.result ?? ""));
  reader.readAsText(file);
}

async function runImport(): Promise<void> {
  importing.value = true;
  error.value = "";
  importErrors.value = [];
  try {
    const result = await importAccounts(importText.value, delimiter.value);
    importErrors.value = result.errors;
    flash(t("accounts.importDone", { imported: result.imported, failed: result.failed }));
    if (result.failed === 0) {
      showImport.value = false;
      importText.value = "";
    }
    await load();
  } catch (err) {
    error.value = errorMessage(err, "Import failed");
  } finally {
    importing.value = false;
  }
}

/**
 * Exports through the authenticated client rather than pointing the browser at the URL: the
 * session token lives in localStorage and is attached by an interceptor, so a plain link or
 * window.open would arrive with no credential and be bounced to the login page.
 */
async function exportAccounts(): Promise<void> {
  try {
    const response = await api.get("/accounts/export", {
      params: { delimiter: delimiter.value },
      responseType: "blob",
    });
    const url = URL.createObjectURL(response.data as Blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "accounts.txt";
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    error.value = errorMessage(err, "Export failed");
  }
}

function confirmDelete(): void {
  if (selected.value.size) showDelete.value = true;
}

async function runDelete(): Promise<void> {
  try {
    await deleteAccounts([...selected.value]);
    selected.value = new Set();
    showDelete.value = false;
    await load();
  } catch (err) {
    error.value = errorMessage(err, "Delete failed");
  }
}

async function refreshTokens(): Promise<void> {
  refreshing.value = true;
  error.value = "";
  try {
    const ids = selected.value.size ? [...selected.value] : undefined;
    const result = await refreshAccountTokens(ids);
    flash(t("accounts.refreshDone", { ok: result.succeeded, failed: result.failed }));
    await load();
  } catch (err) {
    error.value = errorMessage(err, "Refresh failed");
  } finally {
    refreshing.value = false;
  }
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString() : t("common.never");
}

function formatMailDate(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
</script>
