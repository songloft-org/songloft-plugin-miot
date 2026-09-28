import { createApp } from 'vue';
import App from './App.vue';
import { installListCoverVisibilityRecovery } from './covers';
import './style.css';

if (!window.SongloftPlugin && !import.meta.env.DEV) {
  throw new Error('SongloftPlugin 宿主脚本未注入');
}

installListCoverVisibilityRecovery();

createApp(App).mount('#app');
