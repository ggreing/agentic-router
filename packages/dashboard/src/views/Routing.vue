<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { api } from '../api';
import { useResource } from '../useResource';
import { usd, pct } from '../format';
import { t, type MessageKey } from '../i18n';
import type { RoutingView, RoutingLevel, Arm } from '../types';
import StateBanner from '../components/StateBanner.vue';

// Auto-release (decision 138). The routing view rides on the "now" endpoint (router.status().routing).
const res = useResource(() => api.now());
onMounted(res.run);
const routing = computed<RoutingView | null>(() => res.data.value?.routing ?? null);

const armLabel = (lvl: RoutingLevel, which: 'delegated' | 'direct'): string =>
  which === 'delegated' ? t(lvl.released ? 'rt.armProbes' : 'rt.armTeam') : t(lvl.released ? 'rt.armReleased' : 'rt.armHoldout');
const acceptRate = (a: Arm): string => (a.n ? `${a.accepted}/${a.n}` : '—');
const perAccepted = (a: Arm): string => usd(a.costPerAcceptedUsd);

const REASON_KEY: Record<string, MessageKey> = {
  no_direct_cost: 'rt.reasonNoDirectCost', delegated_dearer: 'rt.reasonDelegatedDearer',
  delegated_not_dearer: 'rt.reasonDelegatedNotDearer', inside_band: 'rt.reasonInsideBand',
};
function decisionText(lvl: RoutingLevel, mode: string): string {
  if (!lvl.delegatedByConfig) return t('rt.handledDirectly');
  const d = lvl.decision;
  if (d.reason === 'not_enough_data')
    return t('rt.notEnoughData', { dh: d.need.delegated[0], dn: d.need.delegated[1], ih: d.need.direct[0], in: d.need.direct[1] });
  if (mode === 'observe' && lvl.candidate && d.action === 'release') return t('rt.wouldBeReleased');
  const action = t(d.action === 'release' ? 'rt.actionRelease' : d.action === 'reenable' ? 'rt.actionReenable' : 'rt.actionHold');
  const reason = t(REASON_KEY[d.reason] ?? 'rt.reasonInsideBand');
  const ratio = d.ratio != null ? t('rt.ratioSuffix', { r: d.ratio.toFixed(2) }) : '';
  return t('rt.decision', { action, reason }) + ratio;
}
const modeBadge = (m: string): string => (m === 'on' ? 'ok' : m === 'off' ? 'bad' : 'warn');
</script>

<template>
  <StateBanner v-if="res.loading.value || res.error.value" :loading="res.loading.value" :error="res.error.value" @retry="res.run" />
  <div v-else-if="routing" class="grid">
    <div class="panel row" style="gap: 12px; justify-content: space-between;">
      <div class="row" style="gap: 10px;">
        <strong>{{ t('rt.autoRelease') }}</strong>
        <span :class="['badge', modeBadge(routing.mode)]">{{ t('rt.modeLabel', { mode: routing.mode }) }}</span>
        <span class="muted">{{ t('rt.holdout', { pct: pct(routing.holdoutRate) }) }}</span>
      </div>
      <span class="muted" style="font-size: 12px;">{{ t('rt.ruleText', { x: routing.rule.releaseAbove, d: routing.rule.windowDays, maj: routing.rule.majorityMin, min: routing.rule.minorityMin, re: routing.rule.reenableAtOrBelow }) }}</span>
    </div>

    <p v-if="routing.mode === 'off'" class="panel muted">{{ t('rt.offNote') }}</p>

    <div class="panel" v-for="cls in routing.classes" :key="cls.leadClass">
      <div class="row" style="justify-content: space-between;">
        <strong>{{ t('rt.lead', { cls: cls.leadClass }) }}</strong>
        <span class="muted">{{ t('rt.delegatesFrom', { from: cls.effectiveFrom }) }}<template v-if="cls.autoFrom && cls.autoFrom !== cls.configuredFrom"> {{ t('rt.autoConfigured', { from: cls.configuredFrom }) }}</template></span>
      </div>
      <table style="margin-top: 8px;" v-if="routing.mode !== 'off'">
        <thead><tr><th>{{ t('common.level') }}</th><th>{{ t('rt.thTeamHoldout') }}</th><th>{{ t('rt.thNAccepted') }}</th><th>{{ t('rt.thCostAccepted') }}</th><th>{{ t('rt.thDecision') }}</th></tr></thead>
        <tbody>
          <template v-for="lvl in cls.levels" :key="lvl.level">
            <tr v-if="!lvl.delegatedByConfig">
              <td><span class="badge lvl">{{ lvl.level }}</span></td>
              <td colspan="3" class="muted">{{ t('rt.handledDirectly') }}</td>
              <td class="muted">—</td>
            </tr>
            <tr v-else>
              <td>
                <span class="badge lvl">{{ lvl.level }}</span>
                <span v-if="lvl.released" class="badge ok">{{ t('rt.released') }}</span>
                <span v-else-if="lvl.candidate" class="badge warn">{{ t('rt.candidate') }}</span>
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
  <div v-else class="panel muted">{{ t('rt.notAvailable') }}
    <button class="ghost" @click="res.run" style="margin-left: 8px;">{{ t('common.refresh') }}</button>
  </div>
</template>
