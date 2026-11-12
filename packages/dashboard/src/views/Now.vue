<script setup lang="ts">
import { onMounted } from 'vue';
import { api } from '../api';
import { useResource } from '../useResource';
import { usd } from '../format';
import StateBanner from '../components/StateBanner.vue';

const res = useResource(() => api.now());
onMounted(res.run);
const limitPct = (n: number): string => `${n.toFixed(0)}%`;
</script>

<template>
  <StateBanner v-if="res.loading.value || res.error.value" :loading="res.loading.value" :error="res.error.value" @retry="res.run" />
  <div v-else-if="res.data.value" class="grid">
    <div class="panel" v-if="res.data.value.request">
      <div class="row" style="justify-content: space-between;">
        <strong>Current request <code class="mono">{{ res.data.value.request.id }}</code></strong>
        <button class="ghost" @click="res.run">Refresh</button>
      </div>
      <div class="row" style="margin-top: 8px;">
        <span class="badge lvl">{{ res.data.value.request.level }}</span>
        <span class="badge">{{ res.data.value.request.status }}</span>
        <span class="muted">lead {{ res.data.value.request.leadClass ?? '?' }} ({{ res.data.value.request.leadModel ?? 'unknown' }})</span>
        <span class="muted">·</span>
        <span>cost {{ usd(res.data.value.costUsd) }} / budget {{ usd(res.data.value.request.budgetUsd) }}</span>
        <span v-if="res.data.value.costEstimated" class="badge warn">estimated</span>
        <span v-if="res.data.value.costUnknown" class="badge warn">partly unknown</span>
      </div>
      <div class="row" style="margin-top: 8px;" v-if="res.data.value.limits && (res.data.value.limits.fiveHour || res.data.value.limits.sevenDay)">
        <span class="muted">Subscription:</span>
        <span v-if="res.data.value.limits.fiveHour" class="badge">5h {{ limitPct(res.data.value.limits.fiveHour.usedPercentage) }}</span>
        <span v-if="res.data.value.limits.sevenDay" class="badge">7d {{ limitPct(res.data.value.limits.sevenDay.usedPercentage) }}</span>
      </div>
    </div>
    <div class="panel muted" v-else>No active request in this session.
      <button class="ghost" @click="res.run" style="margin-left: 8px;">Refresh</button>
    </div>

    <div class="panel" v-if="res.data.value.roles.length">
      <strong>Team</strong>
      <table>
        <thead><tr><th>role</th><th>slot</th><th>step</th><th>model × effort</th><th>status</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in res.data.value.roles" :key="i">
            <td>{{ r.role }}</td><td>{{ r.slot }}</td><td>{{ r.step }}</td><td>{{ r.model }} × {{ r.effort }}</td>
            <td><span :class="['badge', r.status === 'passed' ? 'ok' : r.status === 'failed' ? 'bad' : '']">{{ r.status }}</span></td>
          </tr>
        </tbody>
      </table>
      <p class="muted" style="margin-top: 8px;">Session total: {{ usd(res.data.value.sessionCostUsd) }}</p>
    </div>
  </div>
</template>
