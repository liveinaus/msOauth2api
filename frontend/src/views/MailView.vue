<template>
  <div>
    <div class="page-header">
      <div>
        <button class="btn btn-sm" @click="router.push('/')">
          <i class="fa-solid fa-chevron-left"></i> {{ t("mail.back") }}
        </button>
        <div class="page-title" style="margin-top: 10px">{{ email }}</div>
      </div>
      <div class="btn-row">
        <button class="btn" :disabled="loading" @click="load">
          <i class="fa-solid fa-rotate"></i> {{ t("common.refresh") }}
        </button>
        <button class="btn btn-danger" :disabled="loading || !messages.length" @click="showPurge = true">
          <i class="fa-solid fa-trash"></i> {{ t("mail.purge") }}
        </button>
      </div>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ active: mailbox === 'INBOX' }" @click="switchTo('INBOX')">
        {{ t("mail.inbox") }}
      </button>
      <button class="tab" :class="{ active: mailbox === 'Junk' }" @click="switchTo('Junk')">
        {{ t("mail.junk") }}
      </button>
    </div>

    <div v-if="notice" class="alert alert-ok">{{ notice }}</div>
    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t("mail.from") }}</th>
            <th>{{ t("mail.subject") }}</th>
            <th>{{ t("mail.code") }}</th>
            <th>{{ t("mail.date") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(message, index) in pageItems" :key="index">
            <td>{{ message.send }}</td>
            <td class="wrap">
              <span class="clickable" @click="open(message)">{{ message.subject || "(no subject)" }}</span>
            </td>
            <td>
              <span v-if="message.code" class="code-chip">{{ message.code }}</span>
            </td>
            <td>{{ formatDate(message.date) }}</td>
          </tr>
        </tbody>
      </table>

      <div v-if="loading" class="empty-state">{{ t("common.loading") }}</div>
      <div v-else-if="!messages.length" class="empty-state">{{ t("mail.empty") }}</div>
    </div>

    <PaginationBar v-model:page="page" v-model:page-size="pageSize" :total="messages.length" />

    <!-- Message detail -->
    <div v-if="active" class="modal-overlay" @click.self="close">
      <div class="modal modal-lg">
        <div class="modal-header">
          <span>{{ active.subject || "(no subject)" }}</span>
          <button class="modal-close" @click="close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="mail-meta">
            <div>
              <strong>{{ t("mail.from") }}:</strong> {{ active.send }}
            </div>
            <div>
              <strong>{{ t("mail.date") }}:</strong> {{ formatDate(active.date) }}
            </div>
            <div v-if="active.code">
              <strong>{{ t("mail.code") }}:</strong>
              <span class="code-chip">{{ active.code }}</span>
              <button class="btn btn-sm" style="margin-left: 8px" @click="copyCode(active.code)">
                <i class="fa-regular fa-copy"></i> {{ copied ? t("common.copied") : t("common.copy") }}
              </button>
            </div>
          </div>

          <!--
            Sender HTML is rendered in a sandboxed iframe with no allow-scripts and no
            allow-same-origin, so the message cannot reach this origin's session token
            however it is crafted. A blob URL is used rather than srcdoc because the page's
            CSP names blob: in frame-src explicitly.
          -->
          <iframe
            v-if="frameUrl"
            class="mail-frame"
            sandbox=""
            :src="frameUrl"
            referrerpolicy="no-referrer"
          ></iframe>
          <div v-else class="mail-text">{{ active.text || "(empty)" }}</div>
        </div>
        <div class="modal-footer">
          <button v-if="aiAvailable" class="btn" :disabled="aiBusy" @click="analyse">
            <i class="fa-solid fa-wand-magic-sparkles"></i> {{ t("mail.aiAnalyse") }}
          </button>
          <button class="btn" @click="close">{{ t("common.close") }}</button>
        </div>
      </div>
    </div>

    <!-- AI panel -->
    <div v-if="showAi" class="modal-overlay" @click.self="closeAi">
      <div class="modal">
        <div class="modal-header">
          {{ t("mail.aiTitle") }}
          <button class="modal-close" @click="closeAi">&times;</button>
        </div>
        <div class="modal-body">
          <div class="ai-status">{{ aiStatus }}</div>
          <div class="ai-summary">{{ aiSummary }}</div>
        </div>
        <div class="modal-footer">
          <button v-if="aiBusy" class="btn" @click="stopAi">{{ t("common.stop") }}</button>
          <button class="btn" @click="closeAi">{{ t("common.close") }}</button>
        </div>
      </div>
    </div>

    <!-- Purge confirmation -->
    <div v-if="showPurge" class="modal-overlay" @click.self="showPurge = false">
      <div class="modal" style="max-width: 420px">
        <div class="modal-header">{{ t("mail.purge") }}</div>
        <div class="modal-body">
          {{
            t("mail.purgeConfirm", { email, folder: mailbox === "Junk" ? t("mail.junk") : t("mail.inbox") })
          }}
        </div>
        <div class="modal-footer">
          <button class="btn" @click="showPurge = false">{{ t("common.cancel") }}</button>
          <button class="btn btn-danger" @click="runPurge">{{ t("common.delete") }}</button>
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
  errorMessage,
  fetchHealth,
  fetchMail,
  purgeMailbox,
  type MailMessage,
  type Mailbox,
} from "../api/client";
import { t } from "../i18n";
import { persistentRef } from "../utils/prefs";

const props = defineProps<{ email: string }>();
const router = useRouter();

const email = computed(() => props.email);
const mailbox = ref<Mailbox>("INBOX");
const messages = ref<MailMessage[]>([]);
const loading = ref(false);
const error = ref("");
const notice = ref("");
const page = ref(1);
// Shares nothing with the accounts list: a mailbox page and an account page are read at
// different sizes. The folder tab is left alone, being navigation rather than a filter.
const pageSize = persistentRef("mail.pageSize", 25);

const active = ref<MailMessage | null>(null);
const frameUrl = ref("");
const copied = ref(false);
const showPurge = ref(false);

const aiAvailable = ref(false);
const showAi = ref(false);
const aiBusy = ref(false);
const aiStatus = ref("");
const aiSummary = ref("");
let aiController: AbortController | null = null;

const pageItems = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return messages.value.slice(start, start + pageSize.value);
});

watch(pageSize, () => (page.value = 1));

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    messages.value = await fetchMail(email.value, mailbox.value);
    page.value = 1;
  } catch (err) {
    messages.value = [];
    error.value = errorMessage(err, t("mail.loadFailed"));
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  try {
    aiAvailable.value = (await fetchHealth()).aiConfigured;
  } catch {
    aiAvailable.value = false;
  }
});

function switchTo(next: Mailbox): void {
  if (mailbox.value === next) return;
  mailbox.value = next;
  void load();
}

function open(message: MailMessage): void {
  active.value = message;
  revokeFrame();
  if (message.html) {
    // Remote images stay blocked by the page's img-src, which also stops the tracking
    // pixels most marketing mail carries.
    const blob = new Blob([message.html], { type: "text/html" });
    frameUrl.value = URL.createObjectURL(blob);
  }
}

function revokeFrame(): void {
  if (frameUrl.value) {
    URL.revokeObjectURL(frameUrl.value);
    frameUrl.value = "";
  }
}

function close(): void {
  active.value = null;
  copied.value = false;
  revokeFrame();
}

onUnmounted(() => {
  revokeFrame();
  aiController?.abort();
});

async function copyCode(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 2000);
  } catch {
    // Clipboard access can be refused (insecure origin, denied permission); the code is
    // on screen either way, so this needs no error of its own.
  }
}

function formatDate(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

async function runPurge(): Promise<void> {
  showPurge.value = false;
  loading.value = true;
  try {
    const result = await purgeMailbox(email.value, mailbox.value);
    notice.value = t("mail.purgeDone", { n: result.deleted });
    window.setTimeout(() => (notice.value = ""), 4000);
    await load();
  } catch (err) {
    error.value = errorMessage(err, "Could not empty this folder");
  } finally {
    loading.value = false;
  }
}

// ── AI ──────────────────────────────────────────────────────────────────────

function closeAi(): void {
  stopAi();
  showAi.value = false;
}

function stopAi(): void {
  aiController?.abort();
  aiController = null;
  aiBusy.value = false;
}

function buildPrompt(message: MailMessage): string {
  const body = message.text || message.html || "(no content)";
  return [
    "Analyse the following email and summarise the key information.",
    "",
    `From: ${message.send}`,
    `Subject: ${message.subject}`,
    `Date: ${message.date}`,
    "Body:",
    body.slice(0, 8000),
    "",
    "Cover: the type of mail (verification code, marketing, notification), the key details,",
    "and whether it needs a reply or any action.",
  ].join("\n");
}

/**
 * Streams a summary over SSE.
 *
 * fetch rather than EventSource: the endpoint is a POST carrying the message, and
 * EventSource can only issue GETs. The backend forwards the provider's own chunks
 * untouched, so this parses the OpenAI delta format directly.
 */
async function analyse(): Promise<void> {
  const message = active.value;
  if (!message) return;

  showAi.value = true;
  aiBusy.value = true;
  aiSummary.value = "";
  aiStatus.value = t("mail.aiConnecting");

  aiController?.abort();
  aiController = new AbortController();

  try {
    const response = await fetch("/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
      },
      body: JSON.stringify({ messages: [{ role: "user", content: buildPrompt(message) }] }),
      signal: aiController.signal,
    });

    if (!response.ok || !response.body) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `Request failed: ${response.status}`);
    }

    aiStatus.value = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; hold any partial tail for the next chunk.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[];
              error?: string;
            };
            if (parsed.error) throw new Error(parsed.error);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) aiSummary.value += delta;
          } catch {
            // A frame that is not JSON is a keep-alive or a provider comment; skip it.
          }
        }
      }
    }
  } catch (err) {
    if (!aiController?.signal.aborted) {
      aiStatus.value = errorMessage(err, t("mail.aiUnavailable"));
    }
  } finally {
    aiBusy.value = false;
    aiController = null;
  }
}
</script>
