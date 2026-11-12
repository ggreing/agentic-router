<script setup lang="ts">
import { ref } from 'vue';
import Overview from './views/Overview.vue';
import Timeline from './views/Timeline.vue';
import Learning from './views/Learning.vue';
import Routing from './views/Routing.vue';
import Now from './views/Now.vue';
import LanguageSwitcher from './components/LanguageSwitcher.vue';
import { t, type MessageKey } from './i18n';

type TabId = 'overview' | 'timeline' | 'learning' | 'routing' | 'now';
const tabs: Array<{ id: TabId; labelKey: MessageKey }> = [
  { id: 'overview', labelKey: 'tab.overview' },
  { id: 'timeline', labelKey: 'tab.requests' },
  { id: 'learning', labelKey: 'tab.learning' },
  { id: 'routing', labelKey: 'tab.routing' },
  { id: 'now', labelKey: 'tab.now' },
];
const views = { overview: Overview, timeline: Timeline, learning: Learning, routing: Routing, now: Now };
const active = ref<TabId>('overview');
</script>

<template>
  <div class="app">
    <header class="top">
      <h1>{{ t('app.title') }}</h1>
      <span class="sub">{{ t('app.subtitle') }}</span>
      <LanguageSwitcher style="margin-left: auto;" />
    </header>
    <nav class="tabs">
      <button v-for="tab in tabs" :key="tab.id" :class="{ active: active === tab.id }" @click="active = tab.id">{{ t(tab.labelKey) }}</button>
    </nav>
    <component :is="views[active]" />
  </div>
</template>
