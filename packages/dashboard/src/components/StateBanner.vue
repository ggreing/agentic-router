<script setup lang="ts">
import type { ApiError, ApiErrorKind } from '../api';
import { t, type MessageKey } from '../i18n';

const props = defineProps<{ loading: boolean; error: ApiError | null }>();
defineEmits<{ retry: [] }>();

const MESSAGE_KEY: Record<ApiErrorKind, MessageKey> = {
  daemon_off: 'banner.daemonOff', timeout: 'banner.timeout', unauthorized: 'banner.unauthorized', http_error: 'banner.httpError',
};
</script>

<template>
  <div v-if="loading" class="panel muted" role="status">{{ t('banner.loading') }}</div>
  <div v-else-if="props.error" class="panel" role="alert">
    <div class="row" style="justify-content: space-between;">
      <strong>{{ t('banner.cantLoad') }}</strong>
      <button class="ghost" @click="$emit('retry')">{{ t('banner.retry') }}</button>
    </div>
    <p class="muted" style="margin: 8px 0 0;">{{ t(MESSAGE_KEY[props.error.kind]) }}</p>
  </div>
</template>
