<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { api } from '../api';
import { useResource } from '../useResource';
import { usd, pct, pctValue, when } from '../format';
import { t } from '../i18n';
import StatTile from '../components/StatTile.vue';
import BarChart from '../components/BarChart.vue';
import StateBanner from '../components/StateBanner.vue';

const res = useResource(() => api.summary());
onMounted(res.run);

const costByLevel = computed(() => (res.data.value?.byLevel ?? []).map(b => ({ label: b.level, value: b.totalUsd })));
const acc = computed(() => res.data.value?.acceptance ?? null);
const acceptanceHint = computed(() => (acc.value ? t('ov.unobserved', { pct: pct(acc.value.unobservedShare) }) : t('ov.acceptancePending')));
const resetHint = (s: number | null): string => (s ? t('ov.resets', { time: when(new Date(s * 1000).toISOString()) }) : '');
</script>

<template>
  <StateBanner v-if="res.loading.value || res.error.value" :loading="res.loading.value" :error="res.error.value" @retry="res.run" />
  <div v-else-if="res.data.value" class="grid">
    <div class="grid tiles">
      <StatTile :label="t('ov.requests')" :value="String(res.data.value.total)" />
      <StatTile :label="t('ov.noObjection')" :value="pct(res.data.value.successRate)" :hint="acceptanceHint" />
      <StatTile :label="t('ov.costPerAccepted')" :value="usd(res.data.value.costPerAcceptedTaskUsd)" />
      <StatTile :label="t('ov.teamFit')" :value="pct(res.data.value.teamFitRate)" />
      <StatTile :label="t('ov.startStepFit')" :value="pct(res.data.value.startStepFitRate)" />
      <StatTile :label="t('ov.stepUpRate')" :value="pct(res.data.value.upRate)" />
      <StatTile :label="t('ov.cacheHit')" :value="pct(res.data.value.cacheHitRate)" :hint="t('ov.apiMode')" />
      <StatTile :label="t('ov.leadVsWorkers')" :value="`${usd(res.data.value.cost.leadUsd)} / ${usd(res.data.value.cost.subtaskUsd)}`" :hint="t('ov.leadVsWorkersHint')" />
    </div>

    <div class="panel">
      <div class="row" style="justify-content: space-between;">
        <strong>{{ t('ov.costByLevel') }}</strong>
        <span class="muted">{{ t('ov.totalCost', { usd: usd(res.data.value.cost.totalUsd) }) }}</span>
      </div>
      <BarChart :items="costByLevel" unit="$" />
    </div>

    <div class="panel" v-if="acc">
      <strong>{{ t('ov.acceptance') }}</strong>
      <span class="muted" style="font-size: 12px;"> — {{ t('ov.acceptanceNote') }}</span>
      <div class="row" style="margin-top: 8px;">
        <span class="badge ok">{{ t('ov.accepted', { n: acc.accepted }) }}</span>
        <span class="badge bad">{{ t('ov.notAccepted', { n: acc.notAccepted }) }}</span>
        <span class="badge">{{ t('ov.unobservedCount', { n: acc.unobserved }) }}</span>
        <span class="badge" v-if="acc.notApplicable">{{ t('ov.na', { n: acc.notApplicable }) }}</span>
        <span class="badge" v-if="acc.unknown">{{ t('ov.unknownCount', { n: acc.unknown }) }}</span>
      </div>
      <div class="row" style="margin-top: 6px;" v-if="Object.keys(acc.signals).length">
        <span class="muted" style="font-size: 12px;">{{ t('ov.signals') }}</span>
        <span class="badge" v-for="(n, kind) in acc.signals" :key="kind">{{ kind }} {{ n }}</span>
      </div>
    </div>

    <div class="panel" v-if="res.data.value.limits && (res.data.value.limits.fiveHour || res.data.value.limits.sevenDay)">
      <strong>{{ t('ov.subscriptionLimits') }}</strong>
      <div class="grid tiles" style="margin-top: 8px;">
        <StatTile v-if="res.data.value.limits.fiveHour" :label="t('ov.fiveHourUsed')" :value="pctValue(res.data.value.limits.fiveHour.usedPercentage)" :hint="resetHint(res.data.value.limits.fiveHour.resetsAt)" />
        <StatTile v-if="res.data.value.limits.sevenDay" :label="t('ov.sevenDayUsed')" :value="pctValue(res.data.value.limits.sevenDay.usedPercentage)" :hint="resetHint(res.data.value.limits.sevenDay.resetsAt)" />
      </div>
    </div>

    <div class="panel row" style="gap: 14px;">
      <span class="muted">{{ t('ov.baseline') }}</span>
      <span class="badge warn">{{ t('ov.baselinePending') }}</span>
      <span class="muted">{{ t('ov.flags') }}</span>
      <span class="badge" v-if="res.data.value.flags.estimated">{{ t('ov.estimated', { n: res.data.value.flags.estimated }) }}</span>
      <span class="badge" v-if="res.data.value.flags.unknown">{{ t('ov.unknownCostFlag', { n: res.data.value.flags.unknown }) }}</span>
      <span class="badge bad" v-if="res.data.value.flags.budgetExceeded">{{ t('ov.overBudget', { n: res.data.value.flags.budgetExceeded }) }}</span>
    </div>
  </div>
</template>
