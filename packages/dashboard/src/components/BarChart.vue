<script setup lang="ts">
import { computed } from 'vue';

// Inline-SVG horizontal bar chart (no chart library, decision 132). Labels sit beside each bar.
const props = defineProps<{ items: Array<{ label: string; value: number }>; unit?: string }>();

const max = computed(() => Math.max(1, ...props.items.map(i => i.value)));
const ROW_H = 26;
const LABEL_W = 64;
const VAL_W = 70;
const height = computed(() => props.items.length * ROW_H + 6);
const barWidth = (v: number): number => Math.max(0, Math.round((v / max.value) * 100));
const fmt = (v: number): string => `${props.unit ?? ''}${Number.isInteger(v) ? v : v.toFixed(3)}`;
</script>

<template>
  <svg :viewBox="`0 0 400 ${height}`" width="100%" :height="height" role="img" aria-label="bar chart">
    <g v-for="(it, i) in items" :key="it.label" :transform="`translate(0 ${i * ROW_H + 4})`">
      <text :x="0" :y="15" fill="var(--muted)" font-size="12">{{ it.label }}</text>
      <rect :x="LABEL_W" y="4" :width="`${barWidth(it.value) * (400 - LABEL_W - VAL_W) / 100}`" height="14" rx="3" fill="var(--accent)" />
      <text :x="400 - VAL_W + 6" :y="15" fill="var(--ink)" font-size="12">{{ fmt(it.value) }}</text>
    </g>
  </svg>
</template>
