<script setup lang="ts">
import { locale, setLocale, LOCALES, LOCALE_NAMES, type LocaleId } from '../i18n';

function onChange(e: Event): void {
  setLocale((e.target as HTMLSelectElement).value as LocaleId);
}
</script>

<template>
  <select class="lang" :value="locale" @change="onChange" aria-label="Language">
    <option v-for="id in LOCALES" :key="id" :value="id">{{ LOCALE_NAMES[id] }}</option>
  </select>
</template>

<style scoped>
.lang {
  background: var(--panel-2); color: var(--ink); border: 1px solid var(--line);
  border-radius: 8px; padding: 4px 8px; font: inherit; cursor: pointer;
}
</style>
