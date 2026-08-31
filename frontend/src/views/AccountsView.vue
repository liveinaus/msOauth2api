<template>
  <div>
    <div class="page-header">
      <span class="page-title">{{ t("accounts.title") }}</span>
      <div class="btn-row">
        <input v-model="search" class="form-input" style="width: 200px" :placeholder="t('common.search')" />
        <select
          v-model="activeType"
          class="form-input"
          style="width: 150px"
          :title="t('accounts.typeFilterHint')"
        >
          <option value="">{{ t("accounts.allTypes") }}</option>
          <option v-for="item in usageTypes" :key="item.id" :value="item.name">
            {{ item.label || item.name }}
          </option>
        </select>
        <label class="check-row" :title="hideUsedHint">
          <input v-model="hideUsed" type="checkbox" />
          {{ activeType ? t("accounts.hideUsedForType", { type: activeType }) : t("accounts.hideUsed") }}
        </label>
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
        <span class="btn-group" :title="t('accounts.priorityHint')">
          <button class="btn" :disabled="!selected.size || bumping" @click="bumpPriority(1)">
            <i class="fa-solid fa-arrow-up"></i> {{ t("accounts.priority") }}
          </button>
          <button class="btn" :disabled="!selected.size || bumping" @click="bumpPriority(-1)">
            <i class="fa-solid fa-arrow-down"></i>
          </button>
          <button
            class="btn"
            :disabled="!selected.size || bumping"
            :title="t('accounts.clearPriority')"
            @click="resetPriority"
          >
            <i class="fa-solid fa-xmark"></i>
          </button>
        </span>
        <select
          v-model="bulkAuthType"
          class="form-input"
          style="width: 170px"
          :disabled="!selected.size || markingAuthType"
          :title="t('accounts.setAuthTypeHint')"
          @change="applyBulkAuthType"
        >
          <option value="">{{ t("accounts.setAuthType") }}</option>
          <option value="auto">{{ t("accounts.authType.auto") }}</option>
          <option value="imap">{{ t("accounts.authType.imap") }}</option>
        </select>
        <button class="btn btn-danger" :disabled="!selected.size" @click="confirmDelete">
          <i class="fa-solid fa-trash"></i> {{ t("accounts.deleteSelected") }}
        </button>
      </div>
    </div>

    <div v-if="notice" class="alert alert-ok">{{ notice }}</div>
    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <!-- Only worth saying while the filter is what would otherwise be hiding these rows. -->
    <div v-if="hideUsed && pinnedCount()" class="alert alert-info">
      <i class="fa-solid fa-thumbtack"></i>
      {{ t("accounts.pinnedNotice", { n: pinnedCount() }) }}
      <button class="btn btn-sm" style="margin-left: 8px" @click="clearPins">
        {{ t("accounts.releaseAll") }}
      </button>
    </div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="checkbox-cell">
              <input type="checkbox" :checked="allVisibleSelected" @change="toggleAll" />
            </th>
            <th class="seq-cell">{{ t("accounts.seq") }}</th>
            <th class="seq-cell" :title="t('accounts.priorityHint')">{{ t("accounts.priority") }}</th>
            <th>{{ t("accounts.email") }}</th>
            <th class="code-cell">{{ t("accounts.code") }}</th>
            <th v-if="panel.showClientId">{{ t("accounts.clientId") }}</th>
            <th v-if="panel.showRefreshToken">{{ t("accounts.token") }}</th>
            <th>{{ t("accounts.usedFor") }}</th>
            <th>{{ t("accounts.status") }}</th>
            <th>{{ t("accounts.lastRefresh") }}</th>
            <th>{{ t("accounts.lastUsed") }}</th>
            <th>{{ t("common.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="account in pageItems" :key="account.id" :class="{ 'row-pinned': isPinned(account.id) }">
            <td class="checkbox-cell">
              <input
                type="checkbox"
                :checked="selected.has(account.id)"
                @click="selectClick(account.id, $event)"
              />
            </td>
            <td class="seq-cell mono muted" :title="t('accounts.seqHint')">{{ account.id }}</td>
            <td class="seq-cell">
              <!-- Only a set priority is worth ink; 0 is most of the list. -->
              <span
                v-if="account.priority"
                class="badge"
                :class="account.priority > 0 ? 'badge-type' : 'badge-off'"
                :title="t('accounts.priorityHint')"
              >
                {{ account.priority > 0 ? `+${account.priority}` : account.priority }}
              </span>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <div class="cell-row email-cell">
                <span class="clickable" :title="t('accounts.copyEmail')" @click="copyEmail(account)">
                  {{ account.email }}
                </span>
                <button class="btn btn-sm" :title="t('accounts.copyEmail')" @click="copyEmail(account)">
                  <i :class="copiedId === account.id ? 'fa-solid fa-check' : 'fa-regular fa-copy'"></i>
                </button>
              </div>
            </td>
            <td class="code-cell" @mouseenter="showPreview(account.id, $event)" @mouseleave="hidePreview">
              <div class="cell-row">
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
              </div>
            </td>
            <td v-if="panel.showClientId" class="mono">{{ account.clientId }}</td>
            <td v-if="panel.showRefreshToken" class="mono" :title="t('accounts.tokenHidden')">
              {{ account.tokenHint }}
            </td>
            <td>
              <div class="cell-row">
                <span
                  v-for="usage in visibleUsages(account)"
                  :key="usage.type"
                  class="badge"
                  :class="usage.confirmedAt ? 'badge-type' : 'badge-off'"
                  :title="usageTitle(usage)"
                >
                  {{ usage.type }}
                </span>
                <span v-if="!visibleUsages(account).length" class="muted">—</span>
                <button
                  v-if="usageTypes.length"
                  class="btn btn-sm"
                  :title="t('accounts.markUsedFor')"
                  @click="openMarker(account.id, $event)"
                >
                  <i class="fa-solid fa-tags"></i>
                </button>
              </div>
            </td>
            <td>
              <div class="cell-row">
                <span v-if="account.disabled" class="badge badge-off">{{ t("accounts.disabled") }}</span>
                <span
                  v-else-if="account.lastRefreshError"
                  class="badge badge-err"
                  :title="account.lastRefreshError"
                >
                  <i class="fa-solid fa-triangle-exclamation"></i>
                </span>
                <span v-else class="badge badge-ok">{{ t("accounts.enabled") }}</span>
                <!-- Only the non-default grant is worth a badge; "auto" is most of the list. -->
                <span
                  v-if="account.authType === 'imap'"
                  class="badge badge-type"
                  :title="t('accounts.authTypeHint.imap')"
                >
                  IMAP
                </span>
              </div>
            </td>
            <td>{{ formatTime(account.lastRefreshAt) }}</td>
            <td>
              <!-- Scoped to the selected type: with one chosen, "used" means used for it. -->
              <template v-if="activeType">
                <span v-if="usageFor(account)?.confirmedAt">
                  {{ formatTime(usageFor(account)!.confirmedAt) }}
                </span>
                <span
                  v-else-if="usageFor(account)"
                  class="muted"
                  :title="t('accounts.usePendingType', { type: activeType })"
                >
                  {{ t("accounts.claimed") }}
                </span>
                <span v-else class="muted">{{ t("common.never") }}</span>
              </template>
              <template v-else>
                <span v-if="account.lastUsedAt">{{ formatTime(account.lastUsedAt) }}</span>
                <span v-else-if="account.lastCopiedAt" class="muted" :title="t('accounts.usePending')">
                  {{ t("accounts.copiedAt", { time: formatTime(account.lastCopiedAt) }) }}
                </span>
                <span v-else class="muted">{{ t("common.never") }}</span>
              </template>
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
                <button
                  v-if="isPinned(account.id)"
                  class="btn btn-sm"
                  :title="t('accounts.releaseRow')"
                  @click="release(account.id)"
                >
                  <i class="fa-solid fa-thumbtack"></i>
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
        <div class="code-popover-meta">
          {{ preview.send }} · {{ preview.date }}
          <span v-if="preview.junk" class="badge badge-off">{{ t("mail.junk") }}</span>
        </div>
        <div class="code-popover-body">{{ preview.text }}</div>
      </div>
    </Teleport>

    <!-- Mark used for a type, by hand -->
    <Teleport to="body">
      <div v-if="marker" class="popover-backdrop" @click="marker = null">
        <div class="type-menu" :style="{ top: `${marker.top}px`, left: `${marker.left}px` }" @click.stop>
          <div class="type-menu-head">{{ t("accounts.markUsedFor") }}</div>
          <label v-for="item in usageTypes" :key="item.id" class="check-row">
            <input
              type="checkbox"
              :checked="hasUsage(marker.accountId, item.name)"
              @change="toggleUsage(marker.accountId, item.name, ($event.target as HTMLInputElement).checked)"
            />
            {{ item.label || item.name }}
          </label>
        </div>
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
                <span v-if="latestMail.mailbox === 'Junk'" class="badge badge-off">
                  {{ t("mail.junk") }}
                </span>
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
            <label class="form-label">{{ t("accounts.authTypeLabel") }}</label>
            <select v-model="importAuthType" class="form-input">
              <option value="auto">{{ t("accounts.authType.auto") }}</option>
              <option value="imap">{{ t("accounts.authType.imap") }}</option>
            </select>
            <p class="hint">{{ t("accounts.importAuthTypeHint") }}</p>
          </div>
          <div class="form-group">
            <label class="check-row">
              <input v-model="importUseFirst" type="checkbox" />
              {{ t("accounts.importUseFirst") }}
            </label>
            <p class="hint">{{ t("accounts.importUseFirstHint") }}</p>
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
            <label class="form-label">{{ t("accounts.authTypeLabel") }}</label>
            <select v-model="draft.authType" class="form-input">
              <option value="auto">{{ t("accounts.authType.auto") }}</option>
              <option value="imap">{{ t("accounts.authType.imap") }}</option>
            </select>
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
  fetchUsageTypes,
  importAccounts,
  markAccountCopied,
  refreshAccountTokens,
  setAccountsAuthType,
  setAccountsPriority,
  setAccountUsage,
  updateAccount,
  DEFAULT_PANEL_SETTINGS,
  type AccountUsageView,
  type AccountView,
  type AuthType,
  type MailMessage,
  type PanelSettings,
  type UsageTypeView,
} from "../api/client";
import { t } from "../i18n";
import { copyText } from "../utils/clipboard";
import { pageCountOf, pageSlice } from "../utils/pagination";
import { persistentRef } from "../utils/prefs";
import {
  clearPins,
  clock,
  isPinned,
  isPolling,
  latestFor,
  onAccountUpdate,
  pin,
  pinnedCount,
  pollDeadline,
  refreshLatest,
  startPolling,
  unpin,
} from "../stores/latestMail";

const router = useRouter();

const accounts = ref<AccountView[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const importing = ref(false);
const error = ref("");
const notice = ref("");

// Filters persist across reloads; the page number deliberately does not, since it means
// nothing once the list behind it has changed.
const search = persistentRef("accounts.search", "");
const hideUsed = persistentRef("accounts.hideUsed", false);
/** Empty means no type is in play, and "used" keeps its account-wide meaning. */
const activeType = persistentRef("accounts.type", "");
const usageTypes = ref<UsageTypeView[]>([]);
const marker = ref<{ accountId: number; top: number; left: number } | null>(null);
const page = ref(1);
const pageSize = persistentRef("accounts.pageSize", 25);
const selected = ref(new Set<number>());
// Where a shift-click range starts: the last checkbox clicked without shift held.
const anchorId = ref<number | null>(null);

const panel = ref<PanelSettings>({ ...DEFAULT_PANEL_SETTINGS });

const copiedId = ref<number | null>(null);
const codeCopiedId = ref<number | null>(null);
const preview = ref<{
  top: number;
  left: number;
  subject: string;
  send: string;
  date: string;
  junk: boolean;
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
const importAuthType = ref<AuthType>("auto");
// A freshly imported batch is normally the one you want spent next, so this starts on.
const importUseFirst = ref(true);
const draft = ref<{
  email: string;
  clientId: string;
  refreshToken: string;
  authType: AuthType;
  remark: string;
}>({ email: "", clientId: "", refreshToken: "", authType: "auto", remark: "" });
const markingAuthType = ref(false);
const bumping = ref(false);
/** Empty is the placeholder; picking a value applies it and snaps back. */
const bulkAuthType = ref<AuthType | "">("");

const hideUsedHint = computed(() =>
  activeType.value
    ? t("accounts.hideUsedForTypeHint", { type: activeType.value })
    : t("accounts.hideUsedHint"),
);

/** The selected type's record against an account, if it has one. */
function usageFor(account: AccountView): AccountUsageView | undefined {
  return activeType.value ? account.usages.find((u) => u.type === activeType.value) : undefined;
}

/**
 * With a type selected the column narrows to it. Everything on the page is about that type
 * at that point, so tags for the others are noise the eye has to filter out.
 */
function visibleUsages(account: AccountView): AccountUsageView[] {
  if (!activeType.value) return account.usages;
  const usage = usageFor(account);
  return usage ? [usage] : [];
}

const filtered = computed(() => {
  const term = search.value.trim().toLowerCase();
  return accounts.value.filter((a) => {
    // With a type selected the filter is about that type alone, so an address used for
    // something else still shows: it is unused for this one, which is what matters.
    // A pinned row is exempt: it is the one being worked on, and hiding it the moment the
    // copy marked it used is what made this filter awkward to use in the first place.
    if (hideUsed.value && !isPinned(a.id)) {
      if (activeType.value) {
        if (usageFor(a)?.confirmedAt) return false;
      } else if (a.lastUsedAt !== null) return false;
    }
    if (!term) return true;
    return (
      a.email.toLowerCase().includes(term) ||
      a.clientId.toLowerCase().includes(term) ||
      (a.remark ?? "").toLowerCase().includes(term) ||
      a.usages.some((u) => u.type.includes(term))
    );
  });
});

/**
 * Ordered the way the pool hands addresses out, so the top of the table is what the API will
 * spend next. Ties keep id order, which leaves an unmarked list looking exactly as before.
 */
const ordered = computed(() => [...filtered.value].sort((a, b) => b.priority - a.priority || a.id - b.id));

const pageItems = computed(() => pageSlice(ordered.value, page.value, pageSize.value));

const allVisibleSelected = computed(
  () => pageItems.value.length > 0 && pageItems.value.every((a) => selected.value.has(a.id)),
);

// A filter or page-size change can leave the view past the last page, which renders as an
// empty table with rows that do exist.
watch([filtered, pageSize], () => {
  const maxPage = pageCountOf(filtered.value.length, pageSize.value);
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
  try {
    usageTypes.value = await fetchUsageTypes();
    // A type deleted since this browser last stored its filter would otherwise leave the
    // table filtering on something no longer offered in the dropdown.
    if (activeType.value && !usageTypes.value.some((item) => item.name === activeType.value)) {
      activeType.value = "";
    }
  } catch {
    usageTypes.value = [];
  }
});

onUnmounted(() => {
  unsubscribe?.();
  revokeLatestFrame();
});

/**
 * Checkbox clicks, with shift extending from the last plainly clicked row. The anchor's own
 * state drives the range, so shift-click both fills and clears runs. An anchor no longer on
 * the page leaves nothing to span, so that falls back to a plain toggle.
 */
function selectClick(id: number, event: MouseEvent): void {
  const rows = pageItems.value;
  const anchor = anchorId.value;
  const from = anchor === null ? -1 : rows.findIndex((a) => a.id === anchor);
  const to = rows.findIndex((a) => a.id === id);
  const next = new Set(selected.value);

  if (event.shiftKey && anchor !== null && from !== -1 && to !== -1 && from !== to) {
    const select = next.has(anchor);
    const [start, end] = from < to ? [from, to] : [to, from];
    for (const row of rows.slice(start, end + 1)) {
      if (select) next.add(row.id);
      else next.delete(row.id);
    }
  } else if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }

  selected.value = next;
  anchorId.value = id;
  // The browser has already flipped this box; a shift range can disagree with that, and Vue
  // patches nothing when the bound value has not moved, so set it from state directly.
  (event.target as HTMLInputElement).checked = next.has(id);
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

  // Pinned before the mark, so the row cannot flicker out of the list between the two.
  pin(account.id);

  try {
    const updated = await markAccountCopied(account.id, activeType.value || undefined);
    replaceAccount(updated);
    startPolling(account.id, {
      durationMs: panel.value.pollDurationMinutes * 60_000,
      intervalMs: panel.value.pollIntervalSeconds * 1000,
      // The server's own time, so the "did this arrive after the copy?" test is not decided
      // by whatever this browser's clock happens to say. With a type, that is the claim it
      // just made for it.
      since:
        (activeType.value
          ? updated.usages.find((u) => u.type === activeType.value)?.leasedAt
          : updated.lastCopiedAt) ?? Date.now(),
      type: activeType.value || undefined,
    });
  } catch (err) {
    error.value = errorMessage(err, "Could not record the copy");
  }
}

/** Lets a finished row go, and stops the poll that was keeping an eye on it. */
function release(id: number): void {
  unpin(id);
}

function hasUsage(accountId: number, type: string): boolean {
  const account = accounts.value.find((a) => a.id === accountId);
  return Boolean(account?.usages.some((u) => u.type === type && u.confirmedAt));
}

function openMarker(accountId: number, event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const WIDTH = 220;
  marker.value = {
    accountId,
    top: Math.min(rect.bottom + 6, window.innerHeight - 60),
    left: Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8)),
  };
}

async function toggleUsage(accountId: number, type: string, used: boolean): Promise<void> {
  try {
    replaceAccount(await setAccountUsage(accountId, type, used));
  } catch (err) {
    error.value = errorMessage(err, "Could not update the type");
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
    junk: message.mailbox === "Junk",
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

  await refreshLatest(account.id, activeType.value || undefined);
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
      authType: draft.value.authType,
      remark: draft.value.remark.trim() || undefined,
    });
    showAdd.value = false;
    draft.value = { email: "", clientId: "", refreshToken: "", authType: "auto", remark: "" };
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
    const result = await importAccounts(
      importText.value,
      delimiter.value,
      importAuthType.value,
      importUseFirst.value,
    );
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

/**
 * The toolbar control is a select rather than a pair of buttons because there will be more
 * than two grants eventually. It resets to its placeholder after applying, so it reads as an
 * action rather than as the current state of a mixed selection.
 */
async function applyBulkAuthType(): Promise<void> {
  const choice = bulkAuthType.value;
  bulkAuthType.value = "";
  if (choice) await markAuthType(choice);
}

/** Marks every selected account as being on one grant or the other. */
async function markAuthType(authType: AuthType): Promise<void> {
  if (!selected.value.size) return;
  markingAuthType.value = true;
  error.value = "";
  try {
    const result = await setAccountsAuthType([...selected.value], authType);
    flash(t("accounts.authTypeDone", { n: result.updated, type: t(`accounts.authType.${authType}`) }));
    await load();
  } catch (err) {
    error.value = errorMessage(err, "Could not set auth type");
  } finally {
    markingAuthType.value = false;
  }
}

/**
 * Bumps the selection one step up or down the queue.
 *
 * The rows that come back are patched into the list rather than reloading it: a reload would
 * drop the selection, and bumping twice in a row is the normal way to use this.
 */
async function bumpPriority(delta: number): Promise<void> {
  await applyPriority({ delta });
}

/** Puts the selection back to the ordinary case, without having to count clicks back down. */
async function resetPriority(): Promise<void> {
  await applyPriority({ priority: 0 });
}

async function applyPriority(change: { delta: number } | { priority: number }): Promise<void> {
  if (!selected.value.size) return;
  bumping.value = true;
  error.value = "";
  try {
    const result = await setAccountsPriority([...selected.value], change);
    const byId = new Map(result.accounts.map((a) => [a.id, a]));
    accounts.value = accounts.value.map((a) => byId.get(a.id) ?? a);
    flash(t("accounts.priorityDone", { n: result.updated }));
  } catch (err) {
    error.value = errorMessage(err, "Could not change priority");
  } finally {
    bumping.value = false;
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

/** Confirmed types read as "used for X on <date>"; a live lease says it is still out. */
function usageTitle(usage: AccountUsageView): string {
  if (usage.confirmedAt) {
    const when = formatTime(usage.confirmedAt);
    return usage.code
      ? t("accounts.usedForConfirmedCode", { type: usage.type, time: when, code: usage.code })
      : t("accounts.usedForConfirmed", { type: usage.type, time: when });
  }
  return t("accounts.usedForLeased", {
    type: usage.type,
    time: formatTime(usage.leaseExpiresAt),
  });
}

function formatMailDate(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
</script>
