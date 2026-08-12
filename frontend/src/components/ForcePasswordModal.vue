<template>
  <div class="modal-overlay">
    <div class="modal" style="max-width: 420px">
      <div class="modal-header">{{ t("forcePwd.title") }}</div>
      <div class="modal-body">
        <p class="hint">{{ t("forcePwd.subtitle") }}</p>
        <div v-if="error" class="alert alert-error">{{ error }}</div>

        <div class="form-group">
          <label class="form-label">{{ t("settings.currentPassword") }}</label>
          <input
            v-model="currentPassword"
            class="form-input"
            type="password"
            autocomplete="current-password"
          />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("forcePwd.newPassword") }}</label>
          <input v-model="newPassword" class="form-input" type="password" autocomplete="new-password" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("forcePwd.confirmPassword") }}</label>
          <input
            v-model="confirmPassword"
            class="form-input"
            type="password"
            autocomplete="new-password"
            @keyup.enter="submit"
          />
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" :disabled="saving" @click="submit">
          {{ saving ? t("common.saving") : t("forcePwd.submit") }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { errorMessage, updateCredentials } from "../api/client";
import { t } from "../i18n";

const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const saving = ref(false);
const error = ref("");

async function submit(): Promise<void> {
  error.value = "";

  if (newPassword.value.length < 8) {
    error.value = t("forcePwd.tooShort");
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = t("forcePwd.mismatch");
    return;
  }

  saving.value = true;
  try {
    await updateCredentials({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    });
  } catch (err) {
    error.value = errorMessage(err, t("login.error"));
  } finally {
    saving.value = false;
  }
}
</script>
