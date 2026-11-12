<script setup lang="ts">
import { onMounted } from 'vue';
import { api } from '../api';
import { useResource } from '../useResource';
import { pct } from '../format';
import StateBanner from '../components/StateBanner.vue';

const res = useResource(() => api.triage());
onMounted(res.run);
</script>

<template>
  <StateBanner v-if="res.loading.value || res.error.value" :loading="res.loading.value" :error="res.error.value" @retry="res.run" />
  <div v-else-if="res.data.value" class="grid">
    <div class="grid tiles">
      <div class="panel"><div class="muted" style="font-size: 12px;">Requests</div><div style="font-size: 22px; font-weight: 650;">{{ res.data.value.overall.total }}</div></div>
      <div class="panel"><div class="muted" style="font-size: 12px;">Level held</div><div style="font-size: 22px; font-weight: 650;">{{ pct(res.data.value.overall.total ? res.data.value.overall.levelHeld / res.data.value.overall.total : null) }}</div></div>
      <div class="panel"><div class="muted" style="font-size: 12px;">Team fit</div><div style="font-size: 22px; font-weight: 650;">{{ pct(res.data.value.overall.total ? res.data.value.overall.teamFit / res.data.value.overall.total : null) }}</div></div>
      <div class="panel"><div class="muted" style="font-size: 12px;">Start-step fit</div><div style="font-size: 22px; font-weight: 650;">{{ pct(res.data.value.overall.total ? res.data.value.overall.startStepFit / res.data.value.overall.total : null) }}</div></div>
    </div>

    <div class="panel">
      <strong>Triage vs actual, by rule</strong>
      <p class="muted" style="margin: 4px 0 10px;">Suggestions are surfaced, never auto-applied.</p>
      <table>
        <thead><tr><th>rule</th><th>count</th><th>reinforced</th><th>up-streaks</th><th>suggestion</th></tr></thead>
        <tbody>
          <tr v-for="r in res.data.value.byRule" :key="r.rule">
            <td><code class="mono">{{ r.rule }}</code></td><td>{{ r.count }}</td><td>{{ r.reinforced }}</td><td>{{ r.upStreaks }}</td>
            <td>
              <span v-if="r.suggestLevelUp" class="badge warn">raise level</span>
              <span v-if="r.suggestStepUp" class="badge warn">raise start step</span>
              <span v-if="!r.suggestLevelUp && !r.suggestStepUp" class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <strong>Planned → final level</strong>
      <table>
        <thead><tr><th>planned</th><th>final</th><th>count</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in res.data.value.byLevel" :key="i">
            <td><span class="badge lvl">{{ r.planned }}</span></td>
            <td><span class="badge lvl">{{ r.final }}</span><span v-if="r.planned !== r.final" class="badge warn" style="margin-left: 4px;">changed</span></td>
            <td>{{ r.count }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
