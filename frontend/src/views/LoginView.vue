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

    <div class="form-group">
      <label class="form-label">{{ t("login.captcha") }}</label>
      <div class="captcha-row">
        <input
          v-model="captchaAnswer"
          class="form-input"
          autocomplete="off"
          spellcheck="false"
          :placeholder="t('login.captchaPlaceholder')"
          @keyup.enter="submit"
        />
        <!--
          The SVG is shown as an image rather than injected with v-html: an <img> is a
          passive context, so script inside an SVG cannot run, and the page's CSP already
          allows img-src data:.
        -->
        <button
          type="button"
          class="captcha-box"
          :title="t('login.captchaRefresh')"
          :aria-label="t('login.captchaRefresh')"
          @click="loadCaptcha"
        >
          <img v-if="captchaSrc" :src="captchaSrc" alt="" class="captcha-img" />
          <i v-else class="fa-solid fa-rotate" :class="{ 'fa-spin': captchaLoading }"></i>
        </button>
      </div>
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
import { computed, onMounted, ref } from "vue";
import axios from "axios";
import { useRouter } from "vue-router";
import { fetchCaptcha, login } from "../api/client";
import { locale, setLocale, t } from "../i18n";

const router = useRouter();
const username = ref("");
const password = ref("");
const captchaAnswer = ref("");
const captchaToken = ref("");
const captchaSvg = ref("");
const captchaLoading = ref(false);
const busy = ref(false);
const error = ref("");

const captchaSrc = computed(() =>
  captchaSvg.value ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(captchaSvg.value)}` : "",
);

async function loadCaptcha(): Promise<void> {
  captchaLoading.value = true;
  captchaSvg.value = "";
  captchaAnswer.value = "";
  try {
    const challenge = await fetchCaptcha();
    captchaSvg.value = challenge.svg;
    captchaToken.value = challenge.captchaToken;
  } catch {
    captchaToken.value = "";
    error.value = t("login.captchaFailed");
  } finally {
    captchaLoading.value = false;
  }
}

onMounted(loadCaptcha);

async function submit(): Promise<void> {
  if (busy.value) return;
  error.value = "";
  busy.value = true;

  try {
    await login(username.value, password.value, captchaToken.value, captchaAnswer.value);
    await router.replace("/");
  } catch (err) {
    error.value = describe(err);
    // The challenge is burnt on every attempt, win or lose, so a failed sign-in always
    // needs a fresh one. Without this the next attempt fails on the captcha rather than
    // on whatever was actually wrong.
    await loadCaptcha();
  } finally {
    busy.value = false;
  }
}

/**
 * 429 is the login limiter and needs its own message: telling someone their password is
 * wrong when the server never checked it sends them resetting it for no reason. A captcha
 * rejection is likewise not a credential problem.
 */
function describe(err: unknown): string {
  if (!axios.isAxiosError(err)) return t("login.error");

  const status = err.response?.status;
  if (status === 429) return t("login.rateLimited");

  const message = (err.response?.data as { error?: string } | undefined)?.error ?? "";
  if (status === 400 && /captcha/i.test(message)) return t("login.captchaError");
  if (status === 400) return message || t("login.error");

  return t("login.error");
}
</script>
