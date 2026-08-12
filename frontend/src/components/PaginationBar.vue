<template>
  <div class="pagination-bar">
    <span class="pagination-total">{{ t("common.total", { n: total }) }}</span>
    <div class="pagination-controls">
      <select
        class="form-select pagination-size"
        :value="pageSize"
        @change="emit('update:pageSize', Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="size in SIZES" :key="size" :value="size">
          {{ t("common.perPage", { n: size }) }}
        </option>
      </select>
      <button class="btn btn-sm" :disabled="page <= 1" @click="emit('update:page', page - 1)">
        <i class="fa-solid fa-chevron-left"></i>
      </button>
      <span class="pagination-page">{{ page }} / {{ pageCount }}</span>
      <button class="btn btn-sm" :disabled="page >= pageCount" @click="emit('update:page', page + 1)">
        <i class="fa-solid fa-chevron-right"></i>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";

const SIZES = [10, 25, 50, 100];

const props = defineProps<{ page: number; pageSize: number; total: number }>();

const emit = defineEmits<{
  (e: "update:page", value: number): void;
  (e: "update:pageSize", value: number): void;
}>();

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
</script>
