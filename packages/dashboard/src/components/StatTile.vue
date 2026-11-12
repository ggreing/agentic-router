<script setup lang="ts">
defineProps<{ label: string; value: string; hint?: string }>();
</script>

<template>
  <div class="panel">
    <div class="muted" style="font-size: 12px;">{{ label }}</div>
    <div style="font-size: 22px; font-weight: 650; margin-top: 2px;">{{ value }}</div>
    <div v-if="hint" class="muted" style="font-size: 11px; margin-top: 2px;">{{ hint }}</div>
  </div>
</template>
