<script setup lang="ts">
import { computed, ref } from 'vue';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlButton from '../../ui/SlButton.vue';
import SlInput from '../../ui/SlInput.vue';
import SlSelect from '../../ui/SlSelect.vue';
import SlSwitch from '../../ui/SlSwitch.vue';
import SlDisclosure from '../../ui/SlDisclosure.vue';
import { messageOf, notify, saveConfig, state } from '../../store';
import { post } from '../../api';
import type { SelectOption } from '../../types';

const transition = ref(String(state.config.song_transition_offset));
const announcementDelay = ref(String(state.config.play_announcement_delay));
const clearingFailures = ref(false);

async function clearPlaybackFailures() {
  if (clearingFailures.value) return;
  clearingFailures.value = true;
  try {
    const { cleared } = await post<{ cleared: number }>('/player/failures/clear');
    notify(cleared > 0 ? `已清除 ${cleared} 条播放失败标记，可重新播放` : '没有需要清除的播放失败标记', 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  } finally {
    clearingFailures.value = false;
  }
}
const coverOptions: Array<SelectOption & { image: string }> = [
  { value: '1732418460076477549', label: 'LOFT·浮光海岸', image: 'https://p1.music.126.net/y06BHfRn9piijiVWfnP0-Q==/109951166970458072.jpg' },
  { value: '1674532961410650324', label: 'LOFT·海隅', image: 'https://p1.music.126.net/_zoAgg0syiZnUDov2H7Drw==/109951162812527373.jpg' },
  { value: '2882532372925909032', label: 'LOFT·光域', image: 'https://p1.music.126.net/5ccVkZw2OilbPWJg4K_qPg==/109951168994464259.jpg' },
  { value: '436490277987655', label: '星河雀影', image: 'https://y.gtimg.cn/music/photo_new/T001R500x500M000000XFSu32aHi5w_7.jpg' },
  { value: '2284848025338642973', label: '鲸落', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000003MUXTN0hp00B_1.jpg' },
  { value: '3032977774822294038', label: '仲夏涟漪', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000000P52RF0ePrMh_1.jpg' },
  { value: '3573885250148762567', label: '星辰妙漫', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000001XSQmy0sbGRe_1.jpg' },
  { value: '2821554561643067278', label: '所念皆星河', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000003mtKhW0DFTMt_3.jpg' },
  { value: '1949968393125757902', label: '柳岸泊舟', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000003zlK2H16UvnY_2.jpg' },
  { value: '1963040443250771008', label: '花冠少女', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000004HWTo41EPK3L_2.jpg' },
  { value: '703059981413384476', label: '月夜', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000002OGzkK12zb2D_1.jpg' },
  { value: '2182123779048604035', label: '橘子海', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000001wIZl83iCjqo_1.jpg' },
  { value: '1299407089048748519', label: '拾音者', image: 'https://y.gtimg.cn/music/photo_new/T001R500x500M000002knSQ01Ts1vS_0.jpg' },
  { value: '2234266363446166675', label: '唱片', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000003TkJYk3nWUoB_2.jpg' },
  { value: '224322594261696542', label: '音符', image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000003k0x5s4Ale28_1.jpg' },
];
const coverSelectOptions = computed(() => coverOptions.map(({ value, label }) => ({ value, label })));
const coverPreview = computed(() => coverOptions.find((option) => option.value === String(state.config.default_cover_id))?.image || coverOptions[0].image);

async function saveNumber(key: 'song_transition_offset' | 'play_announcement_delay' | 'smart_resume_timeout' | 'conversation_poll_interval' | 'max_song_index' | 'external_search_timeout' | 'voice_memory_max_records', raw: string, min: number, max: number) {
  const parsed = Number.parseInt(raw, 10);
  const value = Math.max(min, Math.min(max, Number.isNaN(parsed) ? min : parsed));
  if (key === 'song_transition_offset') transition.value = String(value);
  if (key === 'play_announcement_delay') announcementDelay.value = String(value);
  try { await saveConfig({ [key]: value }); } catch (error) { notify(messageOf(error), 'error'); }
}
function setSwitch(key: keyof typeof state.config, value: boolean) { void saveConfig({ [key]: value } as never); }
</script>

<template>
  <SectionCard title="音频格式" icon="audio_file">
    <SettingRow title="统一转为 MP3" subtitle="部分音箱仅支持 MP3，开启后播放时自动转码"><SlSwitch aria-label="统一转为 MP3" :model-value="state.config.force_mp3" @update:model-value="setSwitch('force_mp3', $event)" /></SettingRow>
    <SettingRow title="电台转为 MP3" subtitle="兼容无法播放 AAC 或 HLS 电台的设备"><SlSwitch aria-label="电台转为 MP3" :model-value="state.config.radio_force_mp3" @update:model-value="setSwitch('radio_force_mp3', $event)" /></SettingRow>
    <SettingRow title="音量均衡" subtitle="用 EBU R128 统一歌曲音量，需转码"><SlSwitch aria-label="音量均衡" :model-value="state.config.volume_normalize" @update:model-value="setSwitch('volume_normalize', $event)" /></SettingRow>
  </SectionCard>

  <SectionCard title="切歌过渡" icon="swap_horiz" description="负数提前切歌，正数推后切歌；0 为自然播完。范围 -30 到 30 秒。">
    <div class="form-body"><SlInput v-model="transition" type="number" aria-label="切歌偏移秒数" @change="saveNumber('song_transition_offset', transition, -30, 30)" /></div>
  </SectionCard>

  <SectionCard title="播放恢复" icon="refresh" description="播放失败的歌曲会暂时跳过，失败标记在 5 分钟后自动失效。网络恢复后，也可清除所有设备的失败标记，再重新播放。">
    <div class="form-body">
      <SlButton variant="outlined" :label="clearingFailures ? '正在清除…' : '清除播放失败标记'" icon="refresh" :disabled="clearingFailures" @click="clearPlaybackFailures" />
    </div>
  </SectionCard>

  <SectionCard
    title="触屏歌词与封面"
    icon="lyrics"
    description="云端歌词和封面匹配依赖 Music API。在「设备 → 高级设备兼容」中取消型号勾选后，该型号使用直链播放，无法使用这项匹配功能。"
  >
    <SettingRow title="触屏音箱显示歌词" subtitle="仅对兼容 Music API 的型号逐首匹配云端曲库"><SlSwitch aria-label="触屏音箱显示歌词" :model-value="state.config.touchscreen_lyrics_enabled" @update:model-value="setSwitch('touchscreen_lyrics_enabled', $event)" /></SettingRow>
    <div v-if="state.config.touchscreen_lyrics_enabled" class="dependency-hint"><SlIcon name="info" :size="18" /><span>歌词通过逐首匹配云端曲库实现，冷门或自制歌曲可能匹配不到；匹配成功时歌词时间轴也可能与实际播放不完全同步。</span></div>
    <div class="form-body"><div class="field"><label class="field-label">默认封面</label><div class="inline-fields"><SlSelect :model-value="String(state.config.default_cover_id || coverOptions[0].value)" :options="coverSelectOptions" aria-label="默认封面" @update:model-value="saveConfig({ default_cover_id: $event })" /><img :src="coverPreview" alt="默认封面预览" style="width:56px;height:56px;object-fit:cover;border-radius:8px" /></div><p class="field-help">用于触屏音箱或米家 App 无法取得歌曲封面时的兜底。</p></div></div>
  </SectionCard>

  <SlDisclosure title="高级语音衔接" icon="record_voice_over" description="配置搜索提示、播放公告和智能续播。">
    <SettingRow title="搜索提示播报" subtitle="语音搜索时先播报提示文字"><SlSwitch aria-label="搜索提示播报" :model-value="state.config.interrupt_tts_hint_enabled" @update:model-value="setSwitch('interrupt_tts_hint_enabled', $event)" /></SettingRow>
    <div v-if="state.config.interrupt_tts_hint_enabled" class="form-body"><div class="field"><label class="field-label">提示文字</label><SlInput :model-value="state.config.interrupt_tts_hint_text" aria-label="搜索提示文字" @update:model-value="state.config.interrupt_tts_hint_text = $event" @change="saveConfig({ interrupt_tts_hint_text: state.config.interrupt_tts_hint_text })" /></div></div>
    <SettingRow title="播放公告" subtitle="播放前播报歌曲名称"><SlSwitch aria-label="播放公告" :model-value="state.config.play_announcement_enabled" @update:model-value="setSwitch('play_announcement_enabled', $event)" /></SettingRow>
    <div v-if="state.config.play_announcement_enabled" class="form-body"><div class="field"><label class="field-label">触发范围</label><SlSelect :model-value="state.config.play_announcement_scope || 'voice'" :options="[{ value: 'voice', label: '仅语音口令' }, { value: 'all', label: '语音口令 + 网页操作' }]" aria-label="播放公告触发范围" @update:model-value="state.config.play_announcement_scope = $event; saveConfig({ play_announcement_scope: $event })" /><p class="field-help">选择哪些操作会触发播放公告。</p></div><div class="field"><label class="field-label">公告模板</label><SlInput :model-value="state.config.play_announcement_template" aria-label="播放公告模板" @update:model-value="state.config.play_announcement_template = $event" @change="saveConfig({ play_announcement_template: state.config.play_announcement_template })" /><p class="field-help">可用占位符：{artist}、{song}。</p></div><div class="field"><label class="field-label">公告等待时间（秒）</label><SlInput :model-value="announcementDelay" type="number" aria-label="公告等待时间" @update:model-value="announcementDelay = $event" @change="saveNumber('play_announcement_delay', announcementDelay, 0, 30)" /></div></div>
  </SlDisclosure>
</template>
