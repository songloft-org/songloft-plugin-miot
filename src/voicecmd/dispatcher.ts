import type { ConversationMessage } from '../types';
import type { ConfigManager } from '../config/manager';
import type { MusicCommandService } from '../music/service';
import type { AIChatService } from '../chat/service';
import type { PlaybackCoordinator } from '../playback/coordinator';
import { DEFAULT_CHAT_CONFIG, chatScope } from '../chat/types';
import { conversationQuery } from '../conversation/query';
/** 监听只提交任务；每设备最新消息使旧分析失效。 */
export class VoiceDispatcher {
  private versions = new Map<string, number>();
  private seen = new Map<string, number>();
  private closed = false;
  constructor(private config: ConfigManager, private music: MusicCommandService, private chat: AIChatService, private playback: PlaybackCoordinator) {
    playback.setOnDeviceControl?.((account, device) => this.invalidateDevice(account, device));
  }
  invalidateDevice(account: string, device: string): void {
    for (const [scope, version] of this.versions) {
      const [a, d] = JSON.parse(scope);
      if (this.playback.sameScope?.(a, d, account, device) || a === account && d === device)
        this.versions.set(scope, version + 1);
    }
    this.music.cancelPendingResume(account, device);
  }
  submit(message: ConversationMessage): void {
    if (this.closed)
      return;
    const text = conversationQuery(message);
    if (!text)
      return;
    const scope = chatScope(message.account_id, message.device_id);
    const id = `${scope}:${message.message.request_id || `${message.message.timestamp_ms}:${text}`}`;
    if (this.seen.has(id))
      return;
    this.seen.set(id, Date.now());
    if (this.seen.size > 1000)
      this.seen.delete(this.seen.keys().next().value!);
    this.invalidateDevice(message.account_id, message.device_id);
    const version = (this.versions.get(scope) || 0) + 1;
    this.versions.set(scope, version);
    this.music.cancelPendingResume(message.account_id, message.device_id);
    const current = () => !this.closed && this.versions.get(scope) === version;
    void this.dispatch(message, text, current).catch(error => songloft.log.warn(`[VoiceDispatcher] failed=${String(error)}`));
  }
  private async dispatch(message: ConversationMessage, text: string, current: () => boolean): Promise<void> {
    const account = message.account_id, device = message.device_id;
    const config = await this.config.getChatConfig().catch(error => {
      songloft.log.warn(`[VoiceDispatcher] chat_config_failed=${String(error)}`);
      return DEFAULT_CHAT_CONFIG;
    });
    if (!current())
      return;
    const active = this.chat.status(account, device);
    if (config.enabled && /^(停止回答|退出对话|结束对话)[。！!\s]*$/.test(text)) {
      await this.chat.cancel(account, device, true, true);
      return;
    }
    if (config.enabled && /^(停止|停止播放|暂停播放|暂停音乐|暂停|停一下|pause|stop)[。！!\s]*$/.test(text) && ['queued', 'preparing', 'generating', 'speaking', 'resuming'].includes(active.phase)) {
      await this.chat.cancel(account, device, true, false);
      if (current())
        await this.music.handleMessage(message, { deferResume: true, current });
      return;
    }
    if (!current())
      return;
    const fixed = await this.music.fixedControlType?.(text, config.enabled && ['queued', 'preparing', 'generating', 'speaking', 'resuming'].includes(active.phase));
    if (fixed === 'set_volume' && ['queued', 'preparing', 'generating', 'speaking', 'resuming'].includes(active.phase)) {
      if (current())
        await this.music.syncVolumeOnly(account, device);
      return;
    }
    if (fixed || await this.music.hasFixedControl(text)) {
      if (!current())
        return;
      await this.chat.cancel(account, device, true, false);
      await this.music.handleMessage(message, { deferResume: true, current });
      return;
    }
    const trigger = config.trigger_words.find(word => text.startsWith(word));
    if (config.enabled && trigger) {
      if (!current())
        return;
      const question = text.slice(trigger.length).replace(/^[，,：:\s]+/, '').trim();
      if (question)
        await this.chat.submit(account, device, question, true, current);
      return;
    }
    if (!current())
      return;
    // 新语音先停止旧回答，保留 followup 快照用于分流。
    const release = this.chat.interruptForRouting
      ? await this.chat.interruptForRouting(account, device)
      : await this.chat.cancel(account, device, false, false);
    try {
      if (!current())
        return;
      const canChatFallback = () => config.enabled && (config.fallback_enabled || config.followup_enabled && config.followup_seconds > 0 && active.followup_until > Date.now());
      const handled = await this.music.handleMessage(message, { deferResume: true, current, suppressAnalysisFailureHint: canChatFallback });
      if (!current() || handled)
        return;
      if (canChatFallback()) {
        await this.chat.submit(account, device, text, true, current);
        return;
      }
      this.music.resumeUnmatched(account, device);
    }
    finally {
      if (release)
        await release();
    }
  }
  invalidate(): void { this.versions.clear(); this.playback.invalidate(); }
  close(): void { this.closed = true; this.invalidate(); }
}
