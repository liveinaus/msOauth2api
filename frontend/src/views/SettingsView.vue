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
import { onMounted, ref } from "vue";
import {
  createApiKeyRequest,
  deleteApiKeyRequest,
  errorMessage,
  fetchApiKeys,
  fetchHealth,
  fetchPanelSettings,
  savePanelSettings,
  updateCredentials,
  DEFAULT_PANEL_SETTINGS,
  type ApiKeyView,
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

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString() : t("common.never");
}
</script>
