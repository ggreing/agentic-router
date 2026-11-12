<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { api } from '../api';
import { useResource } from '../useResource';
import { usd } from '../format';
import type { RoutingView, RoutingLevel, Arm } from '../types';
import StateBanner from '../components/StateBanner.vue';

// Auto-release (decision 138). The routing view rides on the "now" endpoint (router.status().routing).
const res = useResource(() => api.now());
onMounted(res.run);
const routing = computed<RoutingView | null>(() => res.data.value?.routing ?? null);

const armLabel = (lvl: RoutingLevel, which: 'delegated' | 'direct'): string =>
  which === 'delegated' ? (lvl.released ? 'probes' : 'team') : (lvl.released ? 'released' : 'holdout');
const acceptRate = (a: Arm): string => (a.n ? `${a.accepted}/${a.n}` : '—');
const perAccepted = (a: Arm): string => usd(a.costPerAcceptedUsd);

function decisionText(lvl: RoutingLevel, mode: string): string {
  if (!lvl.delegatedByConfig) return 'handled directly by configuration';
  const d = lvl.decision;
  if (d.reason === 'not_enough_data')
    return `not enough data yet (team ${d.need.delegated[0]}/${d.need.delegated[1]}, direct ${d.need.direct[0]}/${d.need.direct[1]})`;
  if (mode === 'observe' && lvl.candidate && d.action === 'release')
    return 'would be released (observe mode: nothing is switched)';
  const ratio = d.ratio != null ? ` · ratio ${d.ratio.toFixed(2)}` : '';
  const action = d.action === 'release' ? 'release' : d.action === 'reenable' ? 're-enable' : 'hold';
  return `${action} — ${d.reason.replace(/_/g, ' ')}${ratio}`;
}
const modeBadge = (m: string): string => (m === 'on' ? 'ok' : m === 'off' ? 'bad' : 'warn');
</script>

<template>
  <StateBanner v-if="res.loading.value || res.error.value" :loading="res.loading.value" :error="res.error.value" @retry="res.run" />
  <div v-else-if="routing" class="grid">
    <div class="panel row" style="gap: 12px; justify-content: space-between;">
      <div class="row" style="gap: 10px;">
        <strong>Auto-release</strong>
        <span :class="['badge', modeBadge(routing.mode)]">mode: {{ routing.mode }}</span>
        <span class="muted">holdout {{ (routing.holdoutRate * 100).toFixed(0) }}%</span>
      </div>
      <span class="muted" style="font-size: 12px;">
        release when the team costs &gt; {{ routing.rule.releaseAbove }}× direct over {{ routing.rule.windowDays }}d
        (n ≥ {{ routing.rule.majorityMin }}/{{ routing.rule.minorityMin }}); re-enable at ≤ {{ routing.rule.reenableAtOrBelow }}×
      </span>
    </div>

    <p v-if="routing.mode === 'off'" class="panel muted">Auto-release is off: no holdout is taken and no comparison is shown.</p>

    <div class="panel" v-for="cls in routing.classes" :key="cls.leadClass">
      <div class="row" style="justify-content: space-between;">
        <strong>{{ cls.leadClass }} lead</strong>
        <span class="muted">delegates from {{ cls.effectiveFrom }}<template v-if="cls.autoFrom && cls.autoFrom !== cls.configuredFrom"> (auto, configured {{ cls.configuredFrom }})</template></span>
      </div>
      <table style="margin-top: 8px;" v-if="routing.mode !== 'off'">
        <thead><tr><th>level</th><th>{{ 'team / holdout' }}</th><th>n (accepted)</th><th>cost / accepted</th><th>decision</th></tr></thead>
        <tbody>
          <template v-for="lvl in cls.levels" :key="lvl.level">
            <tr v-if="!lvl.delegatedByConfig">
              <td><span class="badge lvl">{{ lvl.level }}</span></td>
              <td colspan="3" class="muted">handled directly by configuration</td>
              <td class="muted">—</td>
            </tr>
            <tr v-else>
              <td>
                <span class="badge lvl">{{ lvl.level }}</span>
                <span v-if="lvl.released" class="badge ok" title="released">released</span>
                <span v-else-if="lvl.candidate" class="badge warn" title="candidate">candidate</span>
              </td>
              <td>
                <div>{{ armLabel(lvl, 'delegated') }}</div>
                <div class="muted">{{ armLabel(lvl, 'direct') }}</div>
              </td>
              <td>
                <div>{{ acceptRate(lvl.delegated) }}</div>
                <div class="muted">{{ acceptRate(lvl.direct) }}</div>
              </td>
              <td>
                <div>{{ perAccepted(lvl.delegated) }}</div>
                <div class="muted">{{ perAccepted(lvl.direct) }}</div>
              </td>
              <td>{{ decisionText(lvl, routing.mode) }}</td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
  <div v-else class="panel muted">Routing data is not available (older daemon, or routing is off).
    <button class="ghost" @click="res.run" style="margin-left: 8px;">Refresh</button>
  </div>
</template>
