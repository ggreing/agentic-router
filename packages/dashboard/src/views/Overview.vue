<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { api } from '../api';
import { useResource } from '../useResource';
import { usd, pct } from '../format';
import StatTile from '../components/StatTile.vue';
import BarChart from '../components/BarChart.vue';
import StateBanner from '../components/StateBanner.vue';

const res = useResource(() => api.summary());
onMounted(res.run);

const costByLevel = computed(() => (res.data.value?.byLevel ?? []).map(b => ({ label: b.level, value: b.totalUsd })));
const acc = computed(() => res.data.value?.acceptance ?? null);
const acceptanceHint = computed(() => (acc.value ? `${pct(acc.value.unobservedShare)} unobserved` : 'verify verdict (acceptance pending)'));
const limitPct = (n: number): string => `${n.toFixed(0)}%`;
const resetHint = (s: number | null): string => (s ? `resets ${new Date(s * 1000).toLocaleString()}` : '');
</script>

<template>
  <StateBanner v-if="res.loading.value || res.error.value" :loading="res.loading.value" :error="res.error.value" @retry="res.run" />
  <div v-else-if="res.data.value" class="grid">
    <div class="grid tiles">
      <StatTile label="Requests" :value="String(res.data.value.total)" />
      <StatTile label="No objection seen" :value="pct(res.data.value.successRate)" :hint="acceptanceHint" />
      <StatTile label="Cost / accepted" :value="usd(res.data.value.costPerAcceptedTaskUsd)" />
      <StatTile label="Team fit" :value="pct(res.data.value.teamFitRate)" />
      <StatTile label="Start-step fit" :value="pct(res.data.value.startStepFitRate)" />
      <StatTile label="Step-up rate" :value="pct(res.data.value.upRate)" />
      <StatTile label="Cache hit" :value="pct(res.data.value.cacheHitRate)" hint="API mode" />
      <StatTile label="Lead vs workers" :value="`${usd(res.data.value.cost.leadUsd)} / ${usd(res.data.value.cost.subtaskUsd)}`" hint="total lead vs subtask cost" />
    </div>

    <div class="panel">
      <div class="row" style="justify-content: space-between;">
        <strong>Cost by level</strong>
        <span class="muted">total {{ usd(res.data.value.cost.totalUsd) }}</span>
      </div>
      <BarChart :items="costByLevel" unit="$" />
    </div>

    <div class="panel" v-if="acc">
      <strong>Acceptance</strong>
      <span class="muted" style="font-size: 12px;"> — "no objection seen"; the rate is an upper bound</span>
      <div class="row" style="margin-top: 8px;">
        <span class="badge ok">accepted {{ acc.accepted }}</span>
        <span class="badge bad">not accepted {{ acc.notAccepted }}</span>
        <span class="badge">unobserved {{ acc.unobserved }}</span>
        <span class="badge" v-if="acc.notApplicable">n/a {{ acc.notApplicable }}</span>
        <span class="badge" v-if="acc.unknown">unknown {{ acc.unknown }}</span>
      </div>
      <div class="row" style="margin-top: 6px;" v-if="Object.keys(acc.signals).length">
        <span class="muted" style="font-size: 12px;">signals:</span>
        <span class="badge" v-for="(n, kind) in acc.signals" :key="kind">{{ kind }} {{ n }}</span>
      </div>
    </div>

    <div class="panel" v-if="res.data.value.limits && (res.data.value.limits.fiveHour || res.data.value.limits.sevenDay)">
      <strong>Subscription limits</strong>
      <div class="grid tiles" style="margin-top: 8px;">
        <StatTile v-if="res.data.value.limits.fiveHour" label="5-hour used" :value="limitPct(res.data.value.limits.fiveHour.usedPercentage)" :hint="resetHint(res.data.value.limits.fiveHour.resetsAt)" />
        <StatTile v-if="res.data.value.limits.sevenDay" label="7-day used" :value="limitPct(res.data.value.limits.sevenDay.usedPercentage)" :hint="resetHint(res.data.value.limits.sevenDay.resetsAt)" />
      </div>
    </div>

    <div class="panel row" style="gap: 14px;">
      <span class="muted">Baseline:</span>
      <span class="badge warn">pending (Phase 0 off-baseline not yet measured)</span>
      <span class="muted">Flags:</span>
      <span class="badge" v-if="res.data.value.flags.estimated">{{ res.data.value.flags.estimated }} estimated</span>
      <span class="badge" v-if="res.data.value.flags.unknown">{{ res.data.value.flags.unknown }} unknown cost</span>
      <span class="badge bad" v-if="res.data.value.flags.budgetExceeded">{{ res.data.value.flags.budgetExceeded }} over budget</span>
    </div>
  </div>
</template>
