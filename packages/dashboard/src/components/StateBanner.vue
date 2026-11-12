<script setup lang="ts">
import type { ApiError } from '../api';

const props = defineProps<{ loading: boolean; error: ApiError | null }>();
defineEmits<{ retry: [] }>();

const MESSAGES: Record<string, string> = {
  daemon_off: 'The router daemon is not running. Start it with `agentic-router start`, then retry.',
  timeout: 'The daemon did not respond in time. It may be busy — retry in a moment.',
  unauthorized: 'This dashboard session has expired. Reopen it with `agentic-router dashboard`.',
  http_error: 'The daemon returned an error. Retry, and check the daemon log if it persists.',
};
</script>

<template>
  <div v-if="loading" class="panel muted" role="status">Loading…</div>
  <div v-else-if="props.error" class="panel" role="alert">
    <div class="row" style="justify-content: space-between;">
      <strong>Can't load data</strong>
      <button class="ghost" @click="$emit('retry')">Retry</button>
    </div>
    <p class="muted" style="margin: 8px 0 0;">{{ MESSAGES[props.error.kind] ?? props.error.message }}</p>
  </div>
</template>
