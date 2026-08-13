<template>
  <div v-if="isPublicRoute" class="full-page">
    <router-view />
  </div>

  <div v-else class="layout">
    <header class="mobile-header">
      <button class="hamburger-btn" :aria-expanded="sidebarOpen" @click="sidebarOpen = !sidebarOpen">
        <i class="fa-solid fa-bars"></i>
      </button>
      <span class="mobile-brand">msOauth2api</span>
      <button class="lang-btn" @click="toggleLocale">{{ locale === "zh" ? "EN" : "中文" }}</button>
    </header>

    <div v-if="sidebarOpen" class="sidebar-backdrop" @click="sidebarOpen = false" />

    <nav class="sidebar" :class="{ 'is-open': sidebarOpen }">
      <div class="sidebar-title">
        <i class="fa-solid fa-envelope-open-text sidebar-logo"></i>
        <span class="sidebar-name">msOauth2api</span>
      </div>

      <router-link class="nav-link" to="/" @click="sidebarOpen = false">
        <i class="fa-solid fa-users"></i>{{ t("nav.accounts") }}
      </router-link>
      <router-link class="nav-link" to="/types" @click="sidebarOpen = false">
        <i class="fa-solid fa-tags"></i>{{ t("nav.types") }}
      </router-link>
      <router-link class="nav-link" to="/settings" @click="sidebarOpen = false">
        <i class="fa-solid fa-gear"></i>{{ t("nav.settings") }}
      </router-link>

      <div class="sidebar-footer">
        <button class="lang-btn" @click="toggleLocale">{{ locale === "zh" ? "EN" : "中文" }}</button>
        <a
          class="github-link"
          href="https://github.com/liveinaus/msOauth2api"
          target="_blank"
          rel="noopener noreferrer"
        >
          <i class="fa-brands fa-github"></i> GitHub
        </a>
        <button class="logout-btn" @click="logout">
          <i class="fa-solid fa-right-from-bracket"></i> {{ t("nav.logout") }}
        </button>
      </div>
    </nav>

    <main class="content">
      <router-view />
    </main>
  </div>

  <ForcePasswordModal v-if="requirePasswordChange" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import ForcePasswordModal from "./components/ForcePasswordModal.vue";
import { logout, requirePasswordChange } from "./api/client";
import { locale, setLocale, t } from "./i18n";

const route = useRoute();
const sidebarOpen = ref(false);

const isPublicRoute = computed(() => route.meta.public === true);

// Close the drawer on navigation so a route change on mobile does not leave it covering
// the page it just opened.
watch(
  () => route.fullPath,
  () => (sidebarOpen.value = false),
);

function toggleLocale(): void {
  setLocale(locale.value === "zh" ? "en" : "zh");
}
</script>
