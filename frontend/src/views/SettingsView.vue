<template>
  <div>
    <div class="page-header">
      <span class="page-title">{{ t("settings.title") }}</span>
    </div>

    <div v-if="notice" class="alert alert-ok">{{ notice }}</div>
    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <!-- Server status -->
    <div class="card">
      <div class="card-title">{{ t("settings.server") }}</div>
      <div v-if="health">
        <div :class="health.encryptionAtRest ? 'alert alert-ok' : 'alert alert-warn'">
          <i :class="health.encryptionAtRest ? 'fa-solid fa-lock' : 'fa-solid fa-lock-open'"></i>
          {{ health.encryptionAtRest ? t("settings.encryptionOn") : t("settings.encryptionOff") }}
        </div>
        <div class="hint">
          <i :class="health.aiConfigured ? 'fa-solid fa-check' : 'fa-solid fa-minus'"></i>
          {{ health.aiConfigured ? t("settings.aiOn") : t("settings.aiOff") }}
        </div>
      </div>
      <div v-else class="hint">{{ t("common.loading") }}</div>
    </div>

    <!-- Panel behaviour -->
    <div class="card">
      <div class="card-title">{{ t("settings.panel") }}</div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">{{ t("settings.pollDuration") }}</label>
          <input
            v-model.number="panel.pollDurationMinutes"
            class="form-input"
            type="number"
            min="1"
            max="60"
          />
          <p class="hint">{{ t("settings.pollDurationHint") }}</p>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("settings.pollInterval") }}</label>
          <input
            v-model.number="panel.pollIntervalSeconds"
            class="form-input"
            type="number"
            min="5"
            max="600"
          />
          <p class="hint">{{ t("settings.pollIntervalHint") }}</p>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">{{ t("settings.leaseMinutes") }}</label>
        <input v-model.number="panel.leaseMinutes" class="form-input" type="number" min="1" max="1440" />
        <p class="hint">{{ t("settings.leaseMinutesHint") }}</p>
      </div>

      <div class="form-group">
        <label class="form-label">{{ t("settings.usageMode") }}</label>
        <select v-model="panel.usageMode" class="form-input">
          <option value="mail">{{ t("settings.usageModeMail") }}</option>
          <option value="copy">{{ t("settings.usageModeCopy") }}</option>
        </select>
        <p class="hint">{{ t("settings.usageModeHint") }}</p>
      </div>

      <div class="form-group">
        <label class="check-row">
          <input v-model="panel.showClientId" type="checkbox" />
          {{ t("settings.showClientId") }}
        </label>
        <label class="check-row">
          <input v-model="panel.showRefreshToken" type="checkbox" />
          {{ t("settings.showRefreshToken") }}
        </label>
      </div>

      <button class="btn btn-primary" :disabled="savingPanel" @click="savePanel">
        {{ savingPanel ? t("common.saving") : t("common.save") }}
      </button>
    </div>

    <!-- Credentials -->
    <div class="card">
      <div class="card-title">{{ t("settings.credentials") }}</div>
      <div class="form-group">
        <label class="form-label">{{ t("settings.currentPassword") }}</label>
        <input v-model="currentPassword" class="form-input" type="password" autocomplete="current-password" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">{{ t("settings.newUsername") }}</label>
          <input v-model="newUsername" class="form-input" autocomplete="username" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("settings.newPassword") }}</label>
          <input v-model="newPassword" class="form-input" type="password" autocomplete="new-password" />
        </div>
      </div>
      <button class="btn btn-primary" :disabled="savingCredentials" @click="saveCredentials">
        {{ savingCredentials ? t("common.saving") : t("common.save") }}
      </button>
    </div>

    <!-- Backup and migration -->
    <div class="card">
      <div class="card-title">{{ t("settings.backup") }}</div>
      <p class="hint">{{ t("settings.backupHint") }}</p>
      <div class="alert alert-warn">
        <i class="fa-solid fa-triangle-exclamation"></i> {{ t("settings.backupWarning") }}
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">{{ t("settings.backupPassphrase") }}</label>
          <input
            v-model="exportPassphrase"
            class="form-input"
            type="password"
            autocomplete="new-password"
            :placeholder="t('settings.backupPassphrasePlaceholder')"
          />
          <p class="hint">{{ t("settings.backupPassphraseHint") }}</p>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("settings.backupPassphraseConfirm") }}</label>
          <input
            v-model="exportPassphraseAgain"
            class="form-input"
            type="password"
            autocomplete="new-password"
          />
          <p v-if="passphraseMismatch" class="hint" style="color: #b3283a">
            {{ t("settings.backupPassphraseMismatch") }}
          </p>
        </div>
      </div>

      <div class="btn-row" style="margin-bottom: 18px">
        <button class="btn" :disabled="exporting || passphraseMismatch" @click="startExport">
          <i class="fa-solid fa-file-export"></i>
          {{ exporting ? t("common.loading") : t("settings.backupExport") }}
        </button>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">{{ t("settings.backupFile") }}</label>
          <input type="file" accept=".json,application/json" @change="loadBackupFile" />
          <p v-if="backupName" class="hint">
            {{ backupName }}
            <span v-if="backupProtected" class="badge badge-type">{{ t("settings.backupProtected") }}</span>
          </p>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("settings.backupMode") }}</label>
          <select v-model="importMode" class="form-input">
            <option value="merge">{{ t("settings.backupMerge") }}</option>
            <option value="replace">{{ t("settings.backupReplace") }}</option>
          </select>
          <p class="hint">
            {{ importMode === "replace" ? t("settings.backupReplaceHint") : t("settings.backupMergeHint") }}
          </p>
        </div>
      </div>

      <div v-if="backupProtected" class="form-group">
        <label class="form-label">{{ t("settings.backupImportPassphrase") }}</label>
        <input
          v-model="importPassphrase"
          class="form-input"
          type="password"
          autocomplete="off"
          style="max-width: 320px"
        />
      </div>

      <div class="form-group">
        <label class="check-row">
          <input v-model="importAdmin" type="checkbox" />
          {{ t("settings.backupIncludeAdmin") }}
        </label>
        <p class="hint">{{ t("settings.backupIncludeAdminHint") }}</p>
      </div>

      <button class="btn btn-primary" :disabled="!backupText || importing" @click="runBackupImport">
        {{ importing ? t("common.saving") : t("settings.backupImport") }}
      </button>

      <div v-if="importReport" class="alert alert-ok" style="margin-top: 14px">
        {{
          t("settings.backupDone", {
            accounts: importReport.accounts,
            types: importReport.usageTypes,
            keys: importReport.apiKeys,
          })
        }}
      </div>
      <div v-if="importReport?.skipped.length" class="alert alert-warn">
        <div>{{ t("settings.backupSkipped", { n: importReport.skipped.length }) }}</div>
        <div v-for="(row, index) in importReport.skipped.slice(0, 20)" :key="index">
          {{ row.where }}: {{ row.reason }}
        </div>
      </div>
    </div>

    <!-- Unprotected export warning -->
    <div v-if="confirmPlain" class="modal-overlay" @click.self="confirmPlain = false">
      <div class="modal" style="max-width: 460px">
        <div class="modal-header">{{ t("settings.backupPlainTitle") }}</div>
        <div class="modal-body">
          <div class="alert alert-warn">
            <i class="fa-solid fa-triangle-exclamation"></i> {{ t("settings.backupPlainWarning") }}
          </div>
          <p class="hint">{{ t("settings.backupPlainAdvice") }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn" @click="confirmPlain = false">{{ t("common.cancel") }}</button>
          <button class="btn btn-danger" @click="downloadBackup(true)">
            {{ t("settings.backupPlainConfirm") }}
          </button>
        </div>
      </div>
    </div>

    <!-- API keys -->
    <div class="card">
      <div class="card-title">{{ t("settings.apiKeys") }}</div>
      <p class="hint">{{ t("settings.apiKeysHint") }}</p>

      <div v-if="freshKey" class="alert alert-warn">
        <div style="margin-bottom: 6px">{{ t("settings.keyOnce") }}</div>
        <code class="mono">{{ freshKey }}</code>
        <button class="btn btn-sm" style="margin-left: 8px" @click="copyKey">
          <i class="fa-regular fa-copy"></i> {{ keyCopied ? t("common.copied") : t("common.copy") }}
        </button>
      </div>

      <div class="btn-row" style="margin-bottom: 14px">
        <input
          v-model="newKeyName"
          class="form-input"
          style="width: 220px"
          :placeholder="t('settings.keyName')"
        />
        <button class="btn btn-primary" :disabled="!newKeyName.trim() || creatingKey" @click="addKey">
          <i class="fa-solid fa-plus"></i> {{ t("settings.createKey") }}
        </button>
      </div>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t("settings.keyName") }}</th>
              <th>{{ t("settings.keyPrefix") }}</th>
              <th>{{ t("settings.lastUsed") }}</th>
              <th>{{ t("settings.created") }}</th>
              <th>{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in apiKeys" :key="key.id">
              <td>{{ key.name }}</td>
              <td class="mono">{{ key.keyPrefix }}…</td>
              <td>{{ formatTime(key.lastUsedAt) }}</td>
              <td>{{ formatTime(key.createdAt) }}</td>
              <td>
                <button class="btn btn-sm btn-danger" @click="removeKey(key.id)">
                  <i class="fa-solid fa-trash"></i>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!apiKeys.length" class="empty-state">{{ t("common.none") }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  createApiKeyRequest,
  deleteApiKeyRequest,
  errorMessage,
  fetchApiKeys,
  fetchBackupFile,
  fetchHealth,
  fetchPanelSettings,
  importBackupFile,
  logout,
  savePanelSettings,
  updateCredentials,
  DEFAULT_PANEL_SETTINGS,
  type ApiKeyView,
  type BackupImportReport,
  type BackupMode,
  type HealthView,
  type PanelSettings,
} from "../api/client";
import { t } from "../i18n";

const health = ref<HealthView | null>(null);
const apiKeys = ref<ApiKeyView[]>([]);
const error = ref("");
const notice = ref("");

const currentPassword = ref("");
const newUsername = ref("");
const newPassword = ref("");
const savingCredentials = ref(false);

const panel = ref<PanelSettings>({ ...DEFAULT_PANEL_SETTINGS });
const savingPanel = ref(false);

const newKeyName = ref("");
const creatingKey = ref(false);
const freshKey = ref("");
const keyCopied = ref(false);

const exporting = ref(false);
const backupText = ref("");
const backupName = ref("");
const backupProtected = ref(false);
const exportPassphrase = ref("");
const exportPassphraseAgain = ref("");
const importPassphrase = ref("");
const confirmPlain = ref(false);
const importMode = ref<BackupMode>("merge");
const importAdmin = ref(false);
const importing = ref(false);
const importReport = ref<BackupImportReport | null>(null);

function flash(message: string): void {
  notice.value = message;
  window.setTimeout(() => (notice.value = ""), 4000);
}

async function load(): Promise<void> {
  try {
    health.value = await fetchHealth();
    apiKeys.value = await fetchApiKeys();
    panel.value = await fetchPanelSettings();
  } catch (err) {
    error.value = errorMessage(err, "Could not load settings");
  }
}

onMounted(load);

/** The server clamps the timings, so the reply is what actually took effect. */
async function savePanel(): Promise<void> {
  error.value = "";
  savingPanel.value = true;
  try {
    panel.value = await savePanelSettings(panel.value);
    flash(t("settings.panelSaved"));
  } catch (err) {
    error.value = errorMessage(err, "Could not save panel settings");
  } finally {
    savingPanel.value = false;
  }
}

async function saveCredentials(): Promise<void> {
  error.value = "";
  savingCredentials.value = true;
  try {
    await updateCredentials({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value || undefined,
      newUsername: newUsername.value.trim() || undefined,
    });
    currentPassword.value = "";
    newPassword.value = "";
    newUsername.value = "";
    flash(t("settings.credentialsSaved"));
  } catch (err) {
    error.value = errorMessage(err, "Could not update credentials");
  } finally {
    savingCredentials.value = false;
  }
}

async function addKey(): Promise<void> {
  error.value = "";
  creatingKey.value = true;
  try {
    const created = await createApiKeyRequest(newKeyName.value.trim());
    freshKey.value = created.key;
    newKeyName.value = "";
    apiKeys.value = await fetchApiKeys();
  } catch (err) {
    error.value = errorMessage(err, "Could not create key");
  } finally {
    creatingKey.value = false;
  }
}

async function copyKey(): Promise<void> {
  try {
    await navigator.clipboard.writeText(freshKey.value);
    keyCopied.value = true;
    window.setTimeout(() => (keyCopied.value = false), 2000);
  } catch {
    // The key is displayed regardless, so a refused clipboard needs no error.
  }
}

async function removeKey(id: number): Promise<void> {
  if (!window.confirm(t("settings.deleteKeyConfirm"))) return;
  try {
    await deleteApiKeyRequest(id);
    apiKeys.value = await fetchApiKeys();
  } catch (err) {
    error.value = errorMessage(err, "Could not delete key");
  }
}

const passphraseMismatch = computed(
  () => Boolean(exportPassphraseAgain.value) && exportPassphrase.value !== exportPassphraseAgain.value,
);

/**
 * An unprotected export is a file holding every refresh token in the clear, so it takes a
 * second, explicit decision rather than one click.
 */
function startExport(): void {
  error.value = "";
  if (exportPassphrase.value.trim()) {
    void downloadBackup(false);
    return;
  }
  confirmPlain.value = true;
}

async function downloadBackup(unprotected: boolean): Promise<void> {
  confirmPlain.value = false;
  error.value = "";
  exporting.value = true;
  try {
    const passphrase = unprotected ? "" : exportPassphrase.value.trim();
    const blob = await fetchBackupFile({ passphrase });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = passphrase
      ? `msoauth2api-backup-${stamp}.protected.json`
      : `msoauth2api-backup-${stamp}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    error.value = errorMessage(err, "Export failed");
  } finally {
    exporting.value = false;
  }
}

function loadBackupFile(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  importReport.value = null;
  backupName.value = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    backupText.value = String(reader.result ?? "");
    try {
      const parsed = JSON.parse(backupText.value) as { format?: string };
      backupProtected.value = parsed.format === "msoauth2api.backup.encrypted";
    } catch {
      backupProtected.value = false;
    }
  };
  reader.readAsText(file);
}

/**
 * Restoring the admin login replaces the credential this session was issued against, so the
 * server retires every token including this one. Signing out here makes that deliberate
 * rather than the panel appearing to break on the next request.
 */
async function runBackupImport(): Promise<void> {
  if (importMode.value === "replace" && !window.confirm(t("settings.backupReplaceConfirm"))) return;

  let document: unknown;
  try {
    document = JSON.parse(backupText.value);
  } catch {
    error.value = t("settings.backupInvalid");
    return;
  }

  error.value = "";
  importing.value = true;
  importReport.value = null;
  try {
    const report = await importBackupFile(document, {
      passphrase: importPassphrase.value,
      mode: importMode.value,
      includeAdmin: importAdmin.value,
    });
    importReport.value = report;

    if (report.admin) {
      flash(t("settings.backupSignOut"));
      window.setTimeout(logout, 3000);
      return;
    }
    await load();
  } catch (err) {
    error.value = errorMessage(err, "Import failed");
  } finally {
    importing.value = false;
  }
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString() : t("common.never");
}
</script>
