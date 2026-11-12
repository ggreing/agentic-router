import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';
import { bootstrapAuth } from './auth';

// Exchange a one-time #code for a session cookie (live mode) before the views fetch, then mount regardless.
bootstrapAuth().finally(() => createApp(App).mount('#app'));
