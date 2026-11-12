<script setup lang="ts">
import { onMounted } from 'vue';
import { api } from '../api';
import { useResource } from '../useResource';
import { pct } from '../format';
import { t } from '../i18n';
import StateBanner from '../components/StateBanner.vue';

const res = useResource(() => api.triage());
onMounted(res.run);
</script>

<template>
  <StateBanner v-if="res.loading.value || res.error.value" :loading="res.loading.value" :error="res.error.value" @retry="res.run" />
  <div v-else-if="res.data.value" class="grid">
    <div class="grid tiles">
      <div class="panel"><div class="muted" style="font-size: 12px;">{{ t('ov.requests') }}</div><div style="font-size: 22px; font-weight: 650;">{{ res.data.value.overall.total }}</div></div>
      <div class="panel"><div class="muted" style="font-size: 12px;">{{ t('lr.levelHeld') }}</div><div style="font-size: 22px; font-weight: 650;">{{ pct(res.data.value.overall.total ? res.data.value.overall.levelHeld / res.data.value.overall.total : null) }}</div></div>
      <div class="panel"><div class="muted" style="font-size: 12px;">{{ t('ov.teamFit') }}</div><div style="font-size: 22px; font-weight: 650;">{{ pct(res.data.value.overall.total ? res.data.value.overall.teamFit / res.data.value.overall.total : null) }}</div></div>
      <div class="panel"><div class="muted" style="font-size: 12px;">{{ t('ov.startStepFit') }}</div><div style="font-size: 22px; font-weight: 650;">{{ pct(res.data.value.overall.total ? res.data.value.overall.startStepFit / res.data.value.overall.total : null) }}</div></div>
    </div>

    <div class="panel">
      <strong>{{ t('lr.triageByRule') }}</strong>
      <p class="muted" style="margin: 4px 0 10px;">{{ t('lr.suggestionsNote') }}</p>
      <table>
        <thead><tr><th>{{ t('lr.thRule') }}</th><th>{{ t('common.count') }}</th><th>{{ t('lr.thReinforced') }}</th><th>{{ t('lr.thUpStreaks') }}</th><th>{{ t('lr.thSuggestion') }}</th></tr></thead>
        <tbody>
          <tr v-for="r in res.data.value.byRule" :key="r.rule">
            <td><code class="mono">{{ r.rule }}</code></td><td>{{ r.count }}</td><td>{{ r.reinforced }}</td><td>{{ r.upStreaks }}</td>
            <td>
              <span v-if="r.suggestLevelUp" class="badge warn">{{ t('lr.raiseLevel') }}</span>
              <span v-if="r.suggestStepUp" class="badge warn">{{ t('lr.raiseStartStep') }}</span>
              <span v-if="!r.suggestLevelUp && !r.suggestStepUp" class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <strong>{{ t('lr.plannedFinal') }}</strong>
      <table>
        <thead><tr><th>{{ t('lr.thPlanned') }}</th><th>{{ t('lr.thFinal') }}</th><th>{{ t('common.count') }}</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in res.data.value.byLevel" :key="i">
            <td><span class="badge lvl">{{ r.planned }}</span></td>
            <td><span class="badge lvl">{{ r.final }}</span><span v-if="r.planned !== r.final" class="badge warn" style="margin-left: 4px;">{{ t('lr.changed') }}</span></td>
            <td>{{ r.count }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
