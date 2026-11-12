<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, ApiError } from '../api';
import { usd, dur, when } from '../format';
import type { TimelineRow, Cursor, RequestDetail, Level } from '../types';
import StateBanner from '../components/StateBanner.vue';

const rows = ref<TimelineRow[]>([]);
const cursor = ref<Cursor | null>(null);
const loading = ref(false);
const error = ref<ApiError | null>(null);
const level = ref<'' | Level>('');
const detail = ref<RequestDetail | null>(null);
const detailError = ref<ApiError | null>(null);

async function load(reset: boolean): Promise<void> {
  loading.value = true; error.value = null;
  try {
    const page = await api.requests({ limit: 12, before: reset ? null : cursor.value, level: level.value || undefined });
    rows.value = reset ? page.rows : [...rows.value, ...page.rows];
    cursor.value = page.nextCursor;
  } catch (e) { error.value = e instanceof ApiError ? e : new ApiError('daemon_off'); }
  finally { loading.value = false; }
}
function setLevel(l: '' | Level): void { level.value = l; detail.value = null; void load(true); }

async function open(id: string): Promise<void> {
  detail.value = null; detailError.value = null;
  try { detail.value = await api.detail(id); }
  catch (e) { detailError.value = e instanceof ApiError ? e : new ApiError('daemon_off'); }
}
const recAcceptance = (d: RequestDetail | null): string | null => (d?.record?.acceptance as { verdict?: string } | undefined)?.verdict ?? null;
const recHoldout = (d: RequestDetail | null): string | null => (d?.record?.plan as { holdout?: string } | undefined)?.holdout ?? null;

onMounted(() => void load(true));
</script>

<template>
  <div class="grid">
    <div class="row">
      <span class="muted">Level:</span>
      <button class="ghost" :class="{ active: level === '' }" @click="setLevel('')">all</button>
      <button class="ghost" v-for="l in (['L0','L1','L2','L3'] as Level[])" :key="l" @click="setLevel(l)">{{ l }}</button>
    </div>

    <StateBanner v-if="(loading && !rows.length) || (error && !rows.length)" :loading="loading" :error="error" @retry="() => load(true)" />

    <div class="panel" v-if="rows.length" style="overflow-x: auto;">
      <table>
        <thead>
          <tr><th>request</th><th>level</th><th>outcome</th><th>lead / workers</th><th>total</th><th>files</th><th>time</th><th>verify</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.requestId" class="clickable" @click="open(r.requestId)">
            <td><code class="mono">{{ r.requestId }}</code><br /><span class="muted" style="font-size: 11px;">{{ when(r.closedAt) }}</span></td>
            <td><span class="badge lvl">{{ r.level }}</span><span v-if="r.level !== r.finalLevel" class="muted"> → {{ r.finalLevel }}</span></td>
            <td>
              <span :class="['badge', r.success ? 'ok' : 'bad']">{{ r.success ? 'ok' : 'failed' }}</span>
              <span class="muted"> {{ r.outcome }}</span>
              <span v-if="r.acceptance === 'not_accepted'" class="badge bad" title="user acceptance">not accepted</span>
              <span v-else-if="r.acceptance === 'unobserved'" class="badge" title="user acceptance">unobserved</span>
              <span v-if="r.holdout" class="badge warn" :title="'routing arm (decision 138)'">{{ r.holdout }}</span>
            </td>
            <td>{{ usd(r.leadUsd) }} / {{ usd(r.subtaskUsd) }}</td>
            <td>{{ usd(r.totalUsd) }}<span v-if="r.estimated" class="badge warn" title="contains an estimate">est</span><span v-if="r.unknown" class="badge warn" title="some cost unknown">?</span><span v-if="r.budgetExceeded" class="badge bad">over</span></td>
            <td>{{ r.changedFiles ?? '—' }} <span class="muted">(+{{ r.linesAdded ?? 0 }}/-{{ r.linesRemoved ?? 0 }})</span></td>
            <td>{{ dur(r.durationMs) }}</td>
            <td>{{ r.verifyFailures ? `${r.verifyFailures} fail` : '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div class="row" style="margin-top: 10px;">
        <button class="ghost" :disabled="!cursor || loading" @click="() => load(false)">{{ cursor ? 'Load more' : 'End' }}</button>
        <span v-if="loading" class="muted">loading…</span>
      </div>
    </div>

    <div class="panel" v-if="detail || detailError">
      <div class="row" style="justify-content: space-between;">
        <strong>Request detail</strong>
        <button class="ghost" @click="detail = null; detailError = null">Close</button>
      </div>
      <p v-if="detailError" class="muted">Could not load detail: {{ detailError.kind }}</p>
      <template v-else-if="detail">
        <p class="muted" style="margin: 6px 0;"><code class="mono">{{ detail.requestId }}</code> · {{ detail.signals.length }} signals · prompt: {{ detail.prompt ? 'recorded' : 'not recorded' }}<span v-if="recAcceptance(detail)"> · acceptance: {{ recAcceptance(detail) }}</span><span v-if="recHoldout(detail)"> · holdout: {{ recHoldout(detail) }}</span></p>
        <table v-if="detail.signals.length">
          <thead><tr><th>subtask</th><th>attempt</th><th>check</th><th>ok</th><th>detail</th></tr></thead>
          <tbody>
            <tr v-for="(s, i) in detail.signals" :key="i">
              <td>{{ s.subtaskId ?? '—' }}</td><td>{{ s.attempt }}</td><td>{{ s.kind }}</td>
              <td><span :class="['badge', s.ok ? 'ok' : 'bad']">{{ s.ok ? 'ok' : 'fail' }}</span></td>
              <td class="muted">{{ s.detail ?? '' }}</td>
            </tr>
          </tbody>
        </table>
        <pre class="json">{{ JSON.stringify(detail.record, null, 2) }}</pre>
      </template>
    </div>
  </div>
</template>
