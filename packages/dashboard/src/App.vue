<script setup lang="ts">
import { ref } from 'vue';
import Overview from './views/Overview.vue';
import Timeline from './views/Timeline.vue';
import Learning from './views/Learning.vue';
import Routing from './views/Routing.vue';
import Now from './views/Now.vue';

type TabId = 'overview' | 'timeline' | 'learning' | 'routing' | 'now';
const tabs: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'timeline', label: 'Requests' },
  { id: 'learning', label: 'Learning' },
  { id: 'routing', label: 'Routing' },
  { id: 'now', label: 'Now' },
];
const views = { overview: Overview, timeline: Timeline, learning: Learning, routing: Routing, now: Now };
const active = ref<TabId>('overview');
</script>

<template>
  <div class="app">
    <header class="top">
      <h1>Agentic Router</h1>
      <span class="sub">read-only local dashboard · all data stays on this machine</span>
    </header>
    <nav class="tabs">
      <button v-for="t in tabs" :key="t.id" :class="{ active: active === t.id }" @click="active = t.id">{{ t.label }}</button>
    </nav>
    <component :is="views[active]" />
  </div>
</template>
