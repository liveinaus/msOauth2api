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
            <th>{{ t("accounts.clientId") }}</th>
            <th>{{ t("accounts.token") }}</th>
            <th>{{ t("accounts.status") }}</th>
            <th>{{ t("accounts.lastRefresh") }}</th>
            <th>{{ t("common.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="account in pageItems" :key="account.id">
            <td class="checkbox-cell">
              <input type="checkbox" :checked="selected.has(account.id)" @change="toggle(account.id)" />
            </td>
            <td>
              <span class="clickable" @click="openMail(account)">{{ account.email }}</span>
            </td>
            <td class="mono">{{ account.clientId }}</td>
            <td class="mono" :title="t('accounts.tokenHidden')">{{ account.tokenHint }}</td>
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
              <div class="btn-row">
                <button class="btn btn-sm" @click="openMail(account)">
                  <i class="fa-solid fa-inbox"></i>
                </button>
                <button class="btn btn-sm" @click="toggleDisabled(account)">
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
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import PaginationBar from "../components/PaginationBar.vue";
import {
  api,
  createAccount,
  deleteAccounts,
  errorMessage,
  fetchAccounts,
  importAccounts,
  refreshAccountTokens,
  updateAccount,
  type AccountView,
} from "../api/client";
import { t } from "../i18n";

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

onMounted(load);

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
</script>
