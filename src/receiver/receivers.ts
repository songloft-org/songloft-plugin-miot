import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';
import type { ConfigManager } from '../config/manager';
import type { MinaService } from '../service/service';
import type { PlaylistManagerMap } from '../player/manager';
import { SSDPDiscovery } from './discovery';
import { DLNAReceiver, httpURL, isLAN, newUUID, peerIP } from './receiver';

interface Settings { enabled: boolean; name: string; base_url: string; }
interface Identity { key: string; uuid: string; }
interface Target { key: string; account_id: string; device_id: string; name: string; }
const CONFIG_KEY = 'dlna_receiver_config';
const IDENTITIES_KEY = 'dlna_receiver_devices';
const keyOf = (account: string, device: string) => JSON.stringify([account, device]);

export class DLNAReceivers {
  private config: Settings = { enabled: false, name: 'Songloft 小爱音箱', base_url: '' };
  private identities: Identity[] = [];
  private receivers = new Map<string, DLNAReceiver>();
  private discovery = new SSDPDiscovery();
  private queue = Promise.resolve();
  private error = '';
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private configs: ConfigManager, private mina: MinaService, private players: PlaylistManagerMap) { }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async init(): Promise<void> {
    const saved = await songloft.storage.get(CONFIG_KEY);
    const records = await songloft.storage.get(IDENTITIES_KEY);
    try {
      const parsed = records ? JSON.parse(String(records)) : [];
      if (Array.isArray(parsed)) this.identities = parsed.filter(i => typeof i?.key === 'string' && /^uuid:[\da-f-]{36}$/.test(i.uuid));
    } catch { }
    try {
      if (saved) this.config = this.validate(JSON.parse(String(saved)));
    } catch (error) { songloft.log.warn('[DLNA] Invalid saved configuration: ' + String(error)); }
    await this.refresh();
    this.scheduleRefresh();
  }

  private validate(input: Settings): Settings {
    if (!input || typeof input.enabled !== 'boolean' || typeof input.name !== 'string' || !input.name.trim()
      || input.name.trim().length > 80 || typeof input.base_url !== 'string') throw new Error('接收器配置无效');
    const next = { enabled: input.enabled, name: input.name.trim(), base_url: input.base_url.trim().replace(/\/+$/, '') };
    if (next.enabled) {
      const base = httpURL(next.base_url);
      if (!next.base_url.startsWith('http://') || !isLAN(base.host) || base.host.startsWith('127.') || base.path.includes('?')) throw new Error('服务器地址须为局域网 HTTP IPv4 地址，可包含部署子路径');
    }
    return next;
  }

  private async targets(): Promise<Target[]> {
    const accounts = await this.configs.getAccounts();
    const groups = await this.configs.getDeviceGroups();
    const grouped = new Set(groups.flatMap(g => g.members.map(m => keyOf(m.account_id, m.device_id))));
    return accounts.flatMap(a => a.devices.filter(d => d.managed && !grouped.has(keyOf(a.id, d.device_id)))
      .map(d => ({ key: keyOf(a.id, d.device_id), account_id: a.id, device_id: d.device_id, name: d.device_name || d.device_id })));
  }

  private async reconcile(): Promise<void> {
    const targets = await this.targets();
    const identities = [...this.identities];
    for (const target of targets) {
      if (identities.some(i => i.key === target.key)) continue;
      identities.push({ key: target.key, uuid: newUUID() });
    }
    // Persist identity before advertising it, so restarts never change a device's UDN.
    if (identities.length !== this.identities.length) {
      await songloft.storage.set(IDENTITIES_KEY, JSON.stringify(identities));
      this.identities = identities;
    }
    const keys = new Set(targets.map(t => t.key));
    for (const [key, receiver] of this.receivers) {
      if (!keys.has(key)) { await receiver.close(); this.receivers.delete(key); }
    }
    for (const target of targets) {
      const identity = this.identities.find(i => i.key === target.key)!;
      let receiver = this.receivers.get(target.key);
      if (!receiver) {
        receiver = new DLNAReceiver(this.configs, this.mina, this.players, identity.uuid, this.discovery);
        this.receivers.set(target.key, receiver);
      }
      const duplicate = targets.some(t => t.key !== target.key && t.name.slice(0, 36) === target.name.slice(0, 36));
      const name = `${this.config.name.slice(0, 30)} · ${target.name.slice(0, 36)}${duplicate ? ` (${identity.uuid.slice(-8)})` : ''}`;
      const next = { ...this.config, name, account_id: target.account_id, device_id: target.device_id };
      const status = receiver.status();
      if (Object.entries(next).some(([key, value]) => key !== 'name' && status[key as keyof typeof next] !== value) || (next.enabled && !status.running)) {
        await receiver.configure(next);
      } else if (status.name !== name) {
        // Discovery labels may change when a duplicate speaker name appears or disappears.
        // Renaming must not interrupt the other speaker's active stream.
        await receiver.rename(name);
      }
    }
  }

  status(hostSupported = true) {
    const receivers = [...this.receivers.entries()].map(([key, receiver]) => ({
      ...receiver.status(), id: this.identities.find(i => i.key === key)!.uuid.slice(5),
    }));
    return { ...this.config, host_supported: hostSupported, running: receivers.some(r => r.running), error: this.error, receivers };
  }

  busyReason(): string {
    for (const receiver of this.receivers.values()) { const reason = receiver.busyReason(); if (reason) return reason; }
    return '';
  }

  async configure(input: Settings): Promise<void> {
    return this.serial(async () => {
      if (this.closed) throw new Error('接收器已关闭');
      const next = this.validate(input);
      const previous = this.config;
      this.config = next;
      for (const receiver of this.receivers.values()) receiver.clearError();
      try {
        await this.reconcile();
        await songloft.storage.set(CONFIG_KEY, JSON.stringify(next));
        this.error = '';
      } catch (error) {
        this.config = previous;
        try { await this.reconcile(); } catch (restoreError) { songloft.log.warn('[DLNA] Restore failed: ' + String(restoreError)); }
        this.error = String(error);
        throw error;
      }
    });
  }

  async refresh(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      try { await this.reconcile(); this.error = ''; }
      catch (error) { this.error = String(error); songloft.log.warn('[DLNA] ' + this.error); }
    });
  }

  private scheduleRefresh(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().finally(() => this.scheduleRefresh());
    }, 30000);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.serial(async () => {
      for (const receiver of this.receivers.values()) await receiver.close();
      this.receivers.clear();
    });
  }

  async handle(req: HTTPRequest): Promise<HTTPResponse> {
    const json = (body: unknown, statusCode = 200): HTTPResponse => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (req.path === '/receiver/config') {
      const supported = 'remoteAddr' in req;
      if (req.method === 'GET') { await this.refresh(); return json(this.status(supported)); }
      if (req.method !== 'PUT') return { statusCode: 405, headers: { Allow: 'GET, PUT' }, body: '' };
      try {
        const body = JSON.parse(typeof req.body === 'string' ? req.body : new TextDecoder().decode(req.body || undefined));
        if (body.enabled && !supported) throw new Error('请升级 Songloft 宿主以支持 DLNA 接收');
        await this.configure(body);
        return json(this.status(supported));
      } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
    }
    if (!isLAN(peerIP(String(req.remoteAddr || '')))) return json({ error: 'DLNA 仅允许局域网访问，需支持对端地址的新版宿主' }, 403);
    const match = req.path.match(/^\/dlna\/([\da-f-]{36})(\/.*)$/);
    if (!match) return { statusCode: 404, body: '' };
    const identity = this.identities.find(i => i.uuid === 'uuid:' + match[1]);
    const receiver = identity && this.receivers.get(identity.key);
    if (!receiver) return { statusCode: 404, body: '' };
    return receiver.handle(req);
  }
}
