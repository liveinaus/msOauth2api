<template>
  <div class="login-card">
    <div class="login-brand">msOauth2api</div>
    <div class="login-subtitle">{{ t("login.subtitle") }}</div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div class="form-group">
      <label class="form-label">{{ t("login.username") }}</label>
      <input v-model="username" class="form-input" autocomplete="username" @keyup.enter="submit" />
    </div>
    <div class="form-group">
      <label class="form-label">{{ t("login.password") }}</label>
      <input
        v-model="password"
        class="form-input"
        type="password"
        autocomplete="current-password"
        @keyup.enter="submit"
      />
    </div>

    <button
      class="btn btn-primary"
      style="width: 100%; justify-content: center"
      :disabled="busy"
      @click="submit"
    >
      {{ busy ? t("login.signingIn") : t("login.signIn") }}
    </button>

    <div style="text-align: center; margin-top: 16px">
      <button class="btn btn-sm" @click="setLocale(locale === 'zh' ? 'en' : 'zh')">
        {{ locale === "zh" ? "English" : "中文" }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import axios from "axios";
import { useRouter } from "vue-router";
import { login } from "../api/client";
import { locale, setLocale, t } from "../i18n";

const router = useRouter();
const username = ref("");
const password = ref("");
const busy = ref(false);
const error = ref("");

async function submit(): Promise<void> {
  if (busy.value) return;
  error.value = "";
  busy.value = true;

  try {
    await login(username.value, password.value);
    await router.replace("/");
  } catch (err) {
    // 429 is the login limiter, which needs its own message: telling someone their password
    // is wrong when the server never checked it sends them resetting it for no reason.
    error.value =
      axios.isAxiosError(err) && err.response?.status === 429 ? t("login.rateLimited") : t("login.error");
  } finally {
    busy.value = false;
  }
}
</script>
