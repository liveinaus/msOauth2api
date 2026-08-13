<template>
  <div>
    <div class="page-header">
      <span class="page-title">{{ t("types.title") }}</span>
      <div class="btn-row">
        <button class="btn btn-primary" @click="openNew">
          <i class="fa-solid fa-plus"></i> {{ t("types.addOne") }}
        </button>
      </div>
    </div>

    <p class="hint">{{ t("types.intro") }}</p>

    <div v-if="notice" class="alert alert-ok">{{ notice }}</div>
    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t("types.name") }}</th>
            <th>{{ t("types.fromFilter") }}</th>
            <th>{{ t("types.subjectFilter") }}</th>
            <th>{{ t("types.codePattern") }}</th>
            <th>{{ t("common.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in types" :key="item.id">
            <td>
              <span class="badge badge-type">{{ item.name }}</span>
              <span v-if="item.label" class="muted" style="margin-left: 8px">{{ item.label }}</span>
            </td>
            <td>{{ item.fromFilter || "—" }}</td>
            <td>{{ item.subjectFilter || "—" }}</td>
            <td class="mono">{{ item.codePattern || "—" }}</td>
            <td>
              <div class="btn-row">
                <button class="btn btn-sm" :title="t('common.edit')" @click="openEdit(item)">
                  <i class="fa-solid fa-pen"></i>
                </button>
                <button class="btn btn-sm btn-danger" :title="t('common.delete')" @click="remove(item)">
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!loading && !types.length" class="empty-state">{{ t("types.empty") }}</div>
      <div v-if="loading" class="empty-state">{{ t("common.loading") }}</div>
    </div>

    <!-- Add / edit -->
    <div v-if="showForm" class="modal-overlay" @click.self="showForm = false">
      <div class="modal">
        <div class="modal-header">
          {{ draft.id ? t("types.editTitle") : t("types.addOne") }}
          <button class="modal-close" @click="showForm = false">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">{{ t("types.name") }}</label>
            <input v-model="draft.name" class="form-input" placeholder="telegram" />
            <p class="hint">{{ t("types.nameHint") }}</p>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("types.label") }}</label>
            <input v-model="draft.label" class="form-input" placeholder="Telegram" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("types.fromFilter") }}</label>
            <input v-model="draft.fromFilter" class="form-input" placeholder="telegram.org" />
            <p class="hint">{{ t("types.fromFilterHint") }}</p>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("types.subjectFilter") }}</label>
            <input v-model="draft.subjectFilter" class="form-input" placeholder="login code" />
            <p class="hint">{{ t("types.subjectFilterHint") }}</p>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("types.codePattern") }}</label>
            <input v-model="draft.codePattern" class="form-input mono" placeholder="code:?\s*(\d{5,6})" />
            <p class="hint">{{ t("types.codePatternHint") }}</p>
            <div v-if="patternProblem" class="alert alert-warn">{{ patternProblem }}</div>
          </div>

          <!-- Try the pattern here rather than by waiting for the next real message. -->
          <div class="form-group">
            <label class="form-label">{{ t("types.testTitle") }}</label>
            <textarea
              v-model="testText"
              class="form-textarea"
              style="min-height: 90px"
              :placeholder="t('types.testPlaceholder')"
            ></textarea>
            <div class="hint">
              {{ t("types.testResult") }}:
              <span v-if="testMatch" class="code-chip">{{ testMatch }}</span>
              <span v-else class="muted">{{ t("types.testNone") }}</span>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" @click="showForm = false">{{ t("common.cancel") }}</button>
          <button class="btn btn-primary" :disabled="saving || !draft.name.trim()" @click="save">
            {{ saving ? t("common.saving") : t("common.save") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  createUsageType,
  deleteUsageType,
  errorMessage,
  fetchUsageTypes,
  updateUsageType,
  type UsageTypeView,
} from "../api/client";
import { t } from "../i18n";

type Draft = {
  id: number | null;
  name: string;
  label: string;
  fromFilter: string;
  subjectFilter: string;
  codePattern: string;
};

const types = ref<UsageTypeView[]>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const notice = ref("");

const showForm = ref(false);
const draft = ref<Draft>(blank());
const testText = ref("");

function blank(): Draft {
  return { id: null, name: "", label: "", fromFilter: "", subjectFilter: "", codePattern: "" };
}

/** Compiled in the browser as well, so a bad expression is caught before it is saved. */
const compiled = computed(() => {
  const pattern = draft.value.codePattern.trim();
  if (!pattern) return { regex: null as RegExp | null, error: "" };
  try {
    return { regex: new RegExp(pattern, "i"), error: "" };
  } catch (err) {
    return { regex: null, error: err instanceof Error ? err.message : String(err) };
  }
});

const patternProblem = computed(() => compiled.value.error);

const testMatch = computed(() => {
  const { regex } = compiled.value;
  if (!regex || !testText.value) return "";
  const match = regex.exec(testText.value);
  if (!match) return "";
  return (match[1] ?? match[0]).trim();
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    types.value = await fetchUsageTypes();
  } catch (err) {
    error.value = errorMessage(err, "Could not load types");
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function flash(message: string): void {
  notice.value = message;
  window.setTimeout(() => (notice.value = ""), 4000);
}

function openNew(): void {
  draft.value = blank();
  testText.value = "";
  showForm.value = true;
}

function openEdit(item: UsageTypeView): void {
  draft.value = {
    id: item.id,
    name: item.name,
    label: item.label ?? "",
    fromFilter: item.fromFilter ?? "",
    subjectFilter: item.subjectFilter ?? "",
    codePattern: item.codePattern ?? "",
  };
  testText.value = "";
  showForm.value = true;
}

async function save(): Promise<void> {
  error.value = "";
  saving.value = true;
  try {
    const payload = {
      name: draft.value.name.trim(),
      label: draft.value.label.trim(),
      fromFilter: draft.value.fromFilter.trim(),
      subjectFilter: draft.value.subjectFilter.trim(),
      codePattern: draft.value.codePattern.trim(),
    };
    if (draft.value.id) await updateUsageType(draft.value.id, payload);
    else await createUsageType(payload);

    showForm.value = false;
    flash(t("types.saved"));
    await load();
  } catch (err) {
    error.value = errorMessage(err, "Could not save this type");
  } finally {
    saving.value = false;
  }
}

async function remove(item: UsageTypeView): Promise<void> {
  if (!window.confirm(t("types.deleteConfirm", { name: item.name }))) return;
  try {
    await deleteUsageType(item.id);
    await load();
  } catch (err) {
    error.value = errorMessage(err, "Could not delete this type");
  }
}
</script>
