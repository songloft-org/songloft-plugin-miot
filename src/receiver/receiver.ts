import type { HTTPRequest, HTTPResponse, NetDataEvent } from '@songloft/plugin-sdk';
import type { ConfigManager } from '../config/manager';
import type { MinaService } from '../service/service';
import type { PlaylistManager, PlaylistManagerMap } from '../player/manager';
import { child, escapeXML, parseXML } from './xml';
import { clock, description, DEVICE, PROTOCOL_INFO, ROOT, SCHEMAS, scpd, ServiceName, soapFault, soapResult, SSDP_ADDR, SSDP_GROUP, TYPES, UPnPError } from './protocol';

export interface ReceiverConfig {
  enabled: boolean;
  name: string;
  base_url: string;
  account_id: string;
  device_id: string;
}
export const DEFAULT_CONFIG: ReceiverConfig = { enabled: false, name: 'Songloft 小爱音箱', base_url: '', account_id: '', device_id: '' };
interface Subscription {
  sid: string; service: ServiceName; callback: string; peer: string; expires: number; seq: number;
  initial: boolean; sending: boolean; latest: string;
}
const CONFIG_KEY = 'dlna_receiver_config';
const UUID_KEY = 'dlna_receiver_uuid';

export function peerIP(address: string): string {
  return address.replace(/^\[::ffff:([\d.]+)\]:\d+$/, '$1').replace(/^([\d.]+):\d+$/, '$1');
}
export function isLAN(ip: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const p = ip.split('.').map(Number);
  if (p.some(n => n > 255) || p.map(String).join('.') !== ip) return false;
  return p[0] === 10 || p[0] === 127 || (p[0] === 192 && p[1] === 168)
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 169 && p[1] === 254);
}
export function httpURL(value: string): { host: string; path: string } {
  // Do not depend on the host's lightweight URL polyfill for authority parsing.
  const m = value.match(/^https?:\/\/([^/?#]+)([^#]*)$/i);
  if (!m || /[\s\\\x00-\x1f\x7f]/.test(value) || m[1].includes('@')) throw new Error('需要有效的 HTTP/HTTPS 地址');
  const authority = m[1].match(/^([a-z\d.-]+)(?::(\d+))?$/i);
  if (!authority || (authority[2] && (+authority[2] < 1 || +authority[2] > 65535))) throw new Error('不支持该地址');
  return { host: authority[1].toLowerCase(), path: m[2] || '/' };
}
export function header(req: HTTPRequest, name: string): string {
  const key = Object.keys(req.headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? req.headers[key].trim() : '';
}
function requestPeer(req: HTTPRequest): string {
  return 'remoteAddr' in req ? peerIP(String(req.remoteAddr || '')) : '';
}
function textBody(req: HTTPRequest): string {
  if (!req.body) return '';
  return typeof req.body === 'string' ? req.body : new TextDecoder().decode(req.body);
}
function newUUID(): string {
  const h = crypto.randomBytes(16).toString('hex');
  return `uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20)}`;
}

export class DLNAReceiver {
  private config = { ...DEFAULT_CONFIG };
  private uuid = '';
  private socket = '';
  private accepting = false;
  private generation = 0;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private searchTimers = new Set<ReturnType<typeof setTimeout>>();
  private subscriptions = new Map<string, Subscription>();
  private queue = Promise.resolve();
  private queued = 0;
  private manager: PlaylistManager | null = null;
  private ownsPlayback = false;
  private uri = '';
  private metadata = '';
  private title = '';
  private transport = 'NO_MEDIA_PRESENT';
  private position = 0;
  private duration = 0;
  private volume = 0;
  private hardPaused = false;
  private stoppedHits = 0;
  private playStartedAt = 0;
  private lastError = '';

  constructor(private configs: ConfigManager, private mina: MinaService, private players: PlaylistManagerMap) { }

  private serial<T>(run: () => Promise<T>, closing = false): Promise<T> {
    if (this.queued >= 32 && !closing) return Promise.reject(new UPnPError(501, 'Receiver busy'));
    this.queued++;
    const result = this.queue.then(run);
    this.queue = result.then(() => undefined, () => undefined).finally(() => { this.queued--; });
    return result;
  }

  async init(): Promise<void> {
    const saved = await songloft.storage.get(CONFIG_KEY);
    try { if (saved) this.config = { ...DEFAULT_CONFIG, ...JSON.parse(String(saved)) }; } catch { }
    this.uuid = String(await songloft.storage.get(UUID_KEY) || '');
    if (!/^uuid:[\da-f-]{36}$/.test(this.uuid)) {
      this.uuid = newUUID();
      await songloft.storage.set(UUID_KEY, this.uuid);
    }
    if (this.config.enabled) {
      try { await this.validate(this.config); await this.start(); }
      catch (e) { this.lastError = String(e); songloft.log.warn('[DLNA] ' + this.lastError); }
    }
  }

  status(hostSupported = true) {
    return {
      ...this.config, running: this.accepting, host_supported: hostSupported, error: this.lastError,
      state: this.transport, uri: this.uri, position: this.position, duration: this.duration
    };
  }
  busyReason(): string { return this.ownsPlayback && this.transport === 'PLAYING' ? 'DLNA receiver playing' : ''; }

  async configure(input: ReceiverConfig): Promise<void> {
    return this.serial(async () => {
      const next: ReceiverConfig = { enabled: input.enabled, name: input.name?.trim(), base_url: input.base_url?.trim().replace(/\/+$/, ''), account_id: input.account_id, device_id: input.device_id };
      await this.validate(next);
      const previous = this.config;
      this.lastError = '';
      await this.stop();
      this.config = next;
      try {
        if (next.enabled) await this.start();
        await songloft.storage.set(CONFIG_KEY, JSON.stringify(next));
      } catch (e) {
        await this.stop();
        this.config = previous;
        if (previous.enabled) {
          try { await this.start(); } catch (restoreError) { songloft.log.warn('[DLNA] Restore failed: ' + String(restoreError)); }
        }
        this.lastError = String(e);
        throw e;
      }
    });
  }

  private async validate(config: ReceiverConfig): Promise<void> {
    if (typeof config.enabled !== 'boolean' || typeof config.name !== 'string' || !config.name || config.name.length > 80
      || typeof config.base_url !== 'string' || typeof config.account_id !== 'string' || typeof config.device_id !== 'string') throw new Error('接收器配置无效');
    if (!config.enabled) return;
    const base = httpURL(config.base_url);
    if (!config.base_url.startsWith('http://') || !isLAN(base.host) || base.host.startsWith('127.') || base.path.includes('?')) throw new Error('服务器地址须为局域网 HTTP IPv4 地址，可包含部署子路径');
    const devices = await this.configs.getDevices(config.account_id);
    if (!devices.some(d => d.device_id === config.device_id && d.managed)) throw new Error('请选择已启用管理的目标音箱');
    const groups = await this.configs.getDeviceGroups();
    if (groups.some(g => g.members.some(m => m.account_id === config.account_id && m.device_id === config.device_id))) throw new Error('首版仅支持独立音箱，请先将目标音箱移出设备分组');
  }

  private endpoint(): string { return `${this.config.base_url}/api/v1/jsplugin/miot`; }
  private advertisements(): string[] { return ['upnp:rootdevice', this.uuid, DEVICE, ...Object.values(TYPES)]; }
  private usn(type: string): string { return type === this.uuid ? this.uuid : `${this.uuid}::${type}`; }

  private async start(): Promise<void> {
    const options = { address: '0.0.0.0:1900', reuseAddress: true };
    const socket = await songloft.net.udpBind(options);
    this.socket = socket.socketId;
    try {
      await songloft.net.udpJoinMulticast(this.socket, SSDP_GROUP);
      songloft.net.onData(this.socket, event => this.onSearch(event));
      await this.announce('ssdp:alive');
      this.accepting = true;
      this.scheduleAnnouncement();
      this.schedulePoll();
    } catch (e) {
      await songloft.net.udpClose(this.socket);
      this.socket = '';
      throw e;
    }
  }

  private async announce(nts: string): Promise<void> {
    const socket = this.socket;
    for (const type of this.advertisements()) {
      await songloft.net.udpSend(socket, `NOTIFY * HTTP/1.1\r\nHOST: ${SSDP_ADDR}\r\nNT: ${type}\r\nNTS: ${nts}\r\nUSN: ${this.usn(type)}\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: ${this.endpoint()}${ROOT}/device.xml\r\nSERVER: Songloft/1.0 UPnP/1.0 MIoT/1.0\r\n\r\n`, SSDP_ADDR);
    }
  }
  private scheduleAnnouncement(): void {
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      void this.serial(async () => {
        if (!this.socket) return;
        try { await this.announce('ssdp:alive'); } catch (e) { songloft.log.warn('[DLNA] Announcement failed: ' + String(e)); }
        this.scheduleAnnouncement();
      }).catch(e => songloft.log.warn('[DLNA] ' + String(e)));
    }, 900000);
  }
  private onSearch(event: NetDataEvent): void {
    const ip = peerIP(event.remoteAddr);
    if (!this.socket || !isLAN(ip) || this.searchTimers.size >= 32) return;
    const raw = atob(event.data);
    if (raw.length > 4096 || !raw.startsWith('M-SEARCH * HTTP/1.1\r\n')) return;
    const headers: Record<string, string> = {};
    for (const line of raw.split('\r\n').slice(1)) {
      const index = line.indexOf(':');
      if (index > 0) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
    }
    if (headers.man !== '"ssdp:discover"' || !/^\d+$/.test(headers.mx || '') || +headers.mx < 1) return;
    const types = this.advertisements().filter(t => headers.st === 'ssdp:all' || headers.st === t);
    if (!types.length) return;
    const generation = this.generation;
    const timer = setTimeout(() => {
      this.searchTimers.delete(timer);
      if (generation !== this.generation || !this.socket) return;
      const socket = this.socket;
      void (async () => {
        for (const type of types) {
          if (generation !== this.generation) return;
          await songloft.net.udpSend(socket, `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\nLOCATION: ${this.endpoint()}${ROOT}/device.xml\r\nSERVER: Songloft/1.0 UPnP/1.0 MIoT/1.0\r\nST: ${type}\r\nUSN: ${this.usn(type)}\r\n\r\n`, event.remoteAddr);
        }
      })().catch(e => songloft.log.warn('[DLNA] Discovery response failed: ' + String(e)));
    }, Math.floor(Math.random() * Math.min(+headers.mx, 5) * 1000));
    this.searchTimers.add(timer);
  }

  async close(): Promise<void> {
    this.accepting = false;
    await this.serial(() => this.stop(), true);
  }
  private async stop(): Promise<void> {
    this.accepting = false;
    this.generation++;
    if (this.announceTimer !== null) clearTimeout(this.announceTimer);
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    for (const timer of this.searchTimers) clearTimeout(timer);
    this.searchTimers.clear();
    this.announceTimer = this.pollTimer = null;
    this.subscriptions.clear();
    if (this.ownsPlayback && this.manager) {
      try {
        const stopped = await this.manager.runExternalPlayback(() => this.mina.stopPlay(this.config.account_id, this.config.device_id));
        if (!stopped) this.lastError = '接收器已关闭，但音箱拒绝停止，请在音箱上停止播放';
      } catch (e) { this.lastError = '停止音箱失败：' + String(e); }
      if (this.lastError) songloft.log.warn('[DLNA] ' + this.lastError);
    }
    this.manager?.endExternalPlayback();
    this.manager = null;
    this.ownsPlayback = false;
    this.uri = this.metadata = this.title = '';
    this.position = this.duration = 0;
    this.transport = 'NO_MEDIA_PRESENT';
    if (this.socket) {
      try { await this.announce('ssdp:byebye'); } catch { }
      try { await songloft.net.udpClose(this.socket); }
      catch (e) { songloft.log.warn('[DLNA] Close socket failed: ' + String(e)); }
      finally { this.socket = ''; }
    }
  }

  async handle(req: HTTPRequest): Promise<HTTPResponse> {
    if (req.path === '/receiver/config') {
      const supported = 'remoteAddr' in req;
      if (req.method === 'GET') return this.json(this.status(supported));
      if (req.method === 'PUT') {
        try {
          const body = JSON.parse(textBody(req));
          if (body.enabled && !supported) throw new Error('请升级 Songloft 宿主以支持 DLNA 接收');
          await this.configure(body);
          return this.json(this.status(supported));
        } catch (e) { return this.json({ error: e instanceof Error ? e.message : String(e) }, 400); }
      }
      return { statusCode: 405, headers: { Allow: 'GET, PUT' }, body: '' };
    }
    if (!isLAN(requestPeer(req))) return this.json({ error: 'DLNA 仅允许局域网访问，需支持对端地址的新版宿主' }, 403);
    if (!this.accepting || !this.config.enabled) return { statusCode: 503, body: 'Receiver disabled' };
    const match = req.path.match(/^\/dlna\/(AVTransport|RenderingControl|ConnectionManager)(\.xml|\/control|\/event)$/);
    if (req.path === `${ROOT}/device.xml` && (req.method === 'GET' || req.method === 'HEAD')) return description(this.config.name, this.uuid, this.endpoint());
    if (!match) return { statusCode: 404, body: '' };
    const service = match[1] as ServiceName;
    if (match[2] === '.xml' && (req.method === 'GET' || req.method === 'HEAD')) return scpd(service);
    if (match[2] === '/event') return this.subscribe(req, service);
    if (match[2] !== '/control' || req.method !== 'POST') return { statusCode: 405, body: '' };
    try {
      return await this.serial(async () => {
        if (!this.accepting) throw new UPnPError(501, 'Receiver disabled');
        const actionHeader = header(req, 'SOAPAction').replace(/^"|"$/g, '');
        const [type, action] = actionHeader.split('#');
        if (type !== TYPES[service] || !Object.prototype.hasOwnProperty.call(SCHEMAS[service].actions, action)) throw new UPnPError(401, 'Invalid Action');
        let args: Record<string, string>;
        try {
          const root = parseXML(textBody(req));
          const body = child(root, 'Body');
          const node = body?.children[0];
          if (root.local !== 'Envelope' || !node || node.local !== action || body?.children.length !== 1) throw new Error('Invalid SOAP');
          args = Object.create(null);
          for (const arg of node.children) {
            if (arg.local in args || arg.children.length) throw new Error('Invalid argument');
            args[arg.local] = arg.text;
          }
          const inputs = SCHEMAS[service].actions[action].filter(a => a[1] === 'in');
          if (Object.keys(args).length !== inputs.length || inputs.some(a => !(a[0] in args))) throw new Error('Invalid arguments');
        } catch { throw new UPnPError(402, 'Invalid Args'); }
        if ('InstanceID' in args && args.InstanceID !== '0') throw new UPnPError(service === 'RenderingControl' ? 702 : 718, 'Invalid InstanceID');
        const before = this.eventBody(service);
        let values;
        try { values = await this.action(service, action, args); }
        finally { if (before !== this.eventBody(service)) this.publish(); }
        return soapResult(service, action, values);
      });
    } catch (e) { return e instanceof UPnPError ? soapFault(e.code, e.message) : soapFault(501, 'Action Failed'); }
  }
  private json(body: unknown, statusCode = 200): HTTPResponse {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  private async takePlayback(): Promise<void> {
    if (this.ownsPlayback) return;
    await this.validate(this.config);
    this.manager = await this.players.getOrCreate(this.config.account_id, this.config.device_id);
    const manager = this.manager;
    this.ownsPlayback = true;
    const acquired = await manager.beginExternalPlayback(() => {
      if (this.manager !== manager) return;
      this.ownsPlayback = false;
      this.transport = this.uri ? 'STOPPED' : 'NO_MEDIA_PRESENT';
      this.publish();
    });
    if (!acquired) throw new UPnPError(501, 'Playback superseded');
  }

  private async playbackCommand<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.ownsPlayback || !this.manager) throw new UPnPError(701, 'Playback superseded');
    const result = await this.manager.runExternalPlayback(operation);
    if (!this.ownsPlayback) throw new UPnPError(701, 'Playback superseded');
    return result;
  }

  private setURI(uri: string, metadata: string): void {
    if (!uri) { this.uri = this.metadata = this.title = ''; this.duration = this.position = 0; return; }
    let info;
    try { info = httpURL(uri); } catch { throw new UPnPError(716, 'Resource not found'); }
    if (info.host === 'localhost' || info.host.startsWith('127.') || info.host === '0.0.0.0') throw new UPnPError(716, 'Resource not reachable by speaker');
    let mime = '', title = '', duration = 0;
    if (metadata) {
      try {
        const didl = parseXML(metadata);
        const item = child(didl, 'item');
        const res = item?.children.find(n => n.local === 'res' && n.text.trim() === uri);
        mime = res?.attrs.protocolInfo?.split(':')[2] || '';
        title = item ? child(item, 'title')?.text || '' : '';
        const time = res?.attrs.duration?.match(/^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/);
        if (time && +time[2] < 60 && +time[3] < 60) duration = +time[1] * 3600 + +time[2] * 60 + +time[3];
        if (!Number.isFinite(duration)) duration = 0;
      } catch { throw new UPnPError(402, 'Invalid metadata'); }
    }
    if ((mime && mime !== 'audio/mpeg' && mime !== 'audio/mp3') || (!mime && !/\.mp3(?:\?|$)/i.test(info.path))) throw new UPnPError(714, 'Only MP3 audio supported');
    this.uri = uri; this.metadata = metadata; this.title = title; this.duration = duration; this.position = 0;
  }

  private async action(service: ServiceName, action: string, args: Record<string, string>): Promise<Record<string, unknown>> {
    const { account_id: account, device_id: device } = this.config;
    if (service === 'ConnectionManager') {
      if (action === 'GetProtocolInfo') return { Source: '', Sink: PROTOCOL_INFO };
      if (action === 'GetCurrentConnectionIDs') return { ConnectionIDs: '0' };
      if (args.ConnectionID !== '0') throw new UPnPError(706, 'Invalid connection reference');
      return { RcsID: 0, AVTransportID: 0, ProtocolInfo: PROTOCOL_INFO, PeerConnectionManager: '', PeerConnectionID: -1, Direction: 'Input', Status: 'OK' };
    }
    if (service === 'RenderingControl') {
      if (action === 'ListPresets') return { CurrentPresetNameList: 'FactoryDefaults' };
      if (action === 'SelectPreset') {
        if (args.PresetName !== 'FactoryDefaults') throw new UPnPError(701, 'Invalid Name');
        return {};
      }
      if (args.Channel !== 'Master') throw new UPnPError(402, 'Invalid Channel');
      if (action === 'SetVolume') {
        if (!/^\d+$/.test(args.DesiredVolume) || +args.DesiredVolume > 100) throw new UPnPError(402, 'Invalid volume');
        if (!await this.mina.setVolume(account, device, +args.DesiredVolume)) throw new UPnPError(501, 'Volume rejected');
        this.volume = +args.DesiredVolume;
        return {};
      }
      const volume = await this.mina.getVolume(account, device);
      if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new UPnPError(501, 'Device unavailable');
      this.volume = volume;
      return { CurrentVolume: volume };
    }
    switch (action) {
      case 'SetAVTransportURI': {
        // Validate before stopping the current stream or changing ownership.
        const old = { uri: this.uri, metadata: this.metadata, title: this.title, duration: this.duration, position: this.position };
        const previousState = this.ownsPlayback ? this.transport : 'STOPPED';
        this.setURI(args.CurrentURI, args.CurrentURIMetaData);
        try {
          await this.takePlayback();
          if (this.uri && previousState === 'PLAYING') {
            if (!await this.playbackCommand(() => this.mina.playURL(account, device, this.uri, this.title))) throw new UPnPError(501, 'Playback rejected');
            this.transport = 'PLAYING'; this.playStartedAt = Date.now(); this.stoppedHits = 0;
          } else {
            if (!await this.playbackCommand(() => this.mina.stopPlay(account, device))) throw new UPnPError(501, 'Stop rejected');
            this.transport = this.uri ? (previousState === 'PAUSED_PLAYBACK' ? previousState : 'STOPPED') : 'NO_MEDIA_PRESENT';
          }
        } catch (e) {
          Object.assign(this, old);
          this.transport = this.uri ? 'STOPPED' : 'NO_MEDIA_PRESENT';
          throw e;
        }
        this.hardPaused = previousState === 'PAUSED_PLAYBACK';
        return {};
      }
      case 'Play': {
        if (args.Speed !== '1') throw new UPnPError(717, 'Play speed not supported');
        if (!this.uri) throw new UPnPError(701, 'No media present');
        if (this.transport === 'PLAYING' && this.ownsPlayback) return {};
        await this.takePlayback();
        const resume = this.transport === 'PAUSED_PLAYBACK' && !this.hardPaused;
        if (!await this.playbackCommand(() => resume ? this.mina.resumePlay(account, device) : this.mina.playURL(account, device, this.uri, this.title))) throw new UPnPError(501, 'Playback rejected');
        this.transport = 'PLAYING'; this.playStartedAt = Date.now(); this.stoppedHits = 0;
        if (!resume) this.position = 0;
        return {};
      }
      case 'Pause': {
        if (this.transport !== 'PLAYING' || !this.ownsPlayback) throw new UPnPError(701, 'Transition not available');
        const result = await this.playbackCommand(() => this.mina.pausePlayVerified(account, device));
        if (result === 'failed') throw new UPnPError(501, 'Pause rejected');
        this.hardPaused = result === 'stopped';
        // A firmware stop cannot resume at the old position without a media proxy.
        this.transport = this.hardPaused ? 'STOPPED' : 'PAUSED_PLAYBACK';
        if (this.hardPaused) this.position = 0;
        return {};
      }
      case 'Stop':
        if (this.ownsPlayback && !await this.playbackCommand(() => this.mina.stopPlay(account, device))) throw new UPnPError(501, 'Stop rejected');
        this.transport = this.uri ? 'STOPPED' : 'NO_MEDIA_PRESENT'; this.position = 0;
        return {};
      case 'GetTransportInfo': return { CurrentTransportState: this.transport, CurrentTransportStatus: 'OK', CurrentSpeed: '1' };
      case 'GetPositionInfo': return { Track: this.uri ? 1 : 0, TrackDuration: clock(this.duration), TrackMetaData: this.metadata, TrackURI: this.uri, RelTime: clock(this.position), AbsTime: 'NOT_IMPLEMENTED', RelCount: 2147483647, AbsCount: 2147483647 };
      case 'GetMediaInfo': return { NrTracks: this.uri ? 1 : 0, MediaDuration: clock(this.duration), CurrentURI: this.uri, CurrentURIMetaData: this.metadata, NextURI: '', NextURIMetaData: '', PlayMedium: this.uri ? 'NETWORK' : 'NONE', RecordMedium: 'NOT_IMPLEMENTED', WriteStatus: 'NOT_IMPLEMENTED' };
      case 'GetDeviceCapabilities': return { PlayMedia: 'NETWORK', RecMedia: 'NOT_IMPLEMENTED', RecQualityModes: 'NOT_IMPLEMENTED' };
      case 'GetTransportSettings': return { PlayMode: 'NORMAL', RecQualityMode: 'NOT_IMPLEMENTED' };
      case 'GetCurrentTransportActions': return { Actions: this.uri ? (this.transport === 'PLAYING' ? 'Stop,Pause' : 'Play,Stop') : '' };
      default: throw new UPnPError(401, 'Invalid Action');
    }
  }

  private subscribe(req: HTTPRequest, service: ServiceName): HTTPResponse {
    this.purgeSubscriptions();
    const sid = header(req, 'SID'), callback = header(req, 'CALLBACK'), nt = header(req, 'NT');
    const peer = requestPeer(req);
    const existing = this.subscriptions.get(sid);
    if (req.method === 'UNSUBSCRIBE') {
      if (callback || nt || !existing || existing.peer !== peer || existing.service !== service) return { statusCode: 412, body: '' };
      this.subscriptions.delete(sid);
      return { statusCode: 200, body: '' };
    }
    if (req.method !== 'SUBSCRIBE') return { statusCode: 405, body: '' };
    const timeout = header(req, 'TIMEOUT');
    if (timeout && timeout !== 'Second-infinite' && !/^Second-\d+$/i.test(timeout)) return { statusCode: 412, body: '' };
    const ttl = timeout && timeout !== 'Second-infinite' ? Math.min(1800, Math.max(60, +timeout.slice(7))) : 1800;
    if (sid) {
      if (callback || nt || !existing || existing.peer !== peer || existing.service !== service) return { statusCode: 412, body: '' };
      existing.expires = Date.now() + ttl * 1000;
      return { statusCode: 200, headers: { SID: sid, TIMEOUT: `Second-${ttl}` }, body: '' };
    }
    let url = '';
    try {
      const match = callback.match(/^<(http:\/\/[^<>]+)>$/);
      if (nt !== 'upnp:event' || !match) throw new Error('Invalid callback');
      url = match[1];
      if (httpURL(url).host !== peer || !isLAN(peer)) throw new Error('Callback must target TCP peer');
    } catch { return { statusCode: 412, body: '' }; }
    if (this.subscriptions.size >= 16) return { statusCode: 503, body: '' };
    const subscription: Subscription = { sid: newUUID(), service, callback: url, peer, expires: Date.now() + ttl * 1000, seq: 0, initial: true, sending: false, latest: '' };
    this.subscriptions.set(subscription.sid, subscription);
    // Send the initial event after the SUBSCRIBE response has returned to the client.
    const timer = setTimeout(() => {
      this.searchTimers.delete(timer);
      subscription.initial = false;
      if (this.subscriptions.get(subscription.sid) === subscription) this.notify(subscription);
    }, 100);
    this.searchTimers.add(timer);
    return { statusCode: 200, headers: { SID: subscription.sid, TIMEOUT: `Second-${ttl}` }, body: '' };
  }
  private purgeSubscriptions(): void {
    for (const [sid, sub] of this.subscriptions) if (sub.expires <= Date.now()) this.subscriptions.delete(sid);
  }
  private eventBody(service: ServiceName): string {
    if (service === 'ConnectionManager') return `<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><SourceProtocolInfo></SourceProtocolInfo></e:property><e:property><SinkProtocolInfo>${escapeXML(PROTOCOL_INFO)}</SinkProtocolInfo></e:property><e:property><CurrentConnectionIDs>0</CurrentConnectionIDs></e:property></e:propertyset>`;
    const content = service === 'AVTransport'
      ? `<TransportState val="${this.transport}"/><TransportStatus val="OK"/><TransportPlaySpeed val="1"/><CurrentTrack val="${this.uri ? 1 : 0}"/><NumberOfTracks val="${this.uri ? 1 : 0}"/><CurrentTrackDuration val="${clock(this.duration)}"/><CurrentMediaDuration val="${clock(this.duration)}"/><AVTransportURI val="${escapeXML(this.uri)}"/><AVTransportURIMetaData val="${escapeXML(this.metadata)}"/><CurrentTrackURI val="${escapeXML(this.uri)}"/><CurrentTrackMetaData val="${escapeXML(this.metadata)}"/>`
      : `<Volume channel="Master" val="${this.volume}"/>`;
    const change = `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/${service === 'AVTransport' ? 'AVT' : 'RCS'}/"><InstanceID val="0">${content}</InstanceID></Event>`;
    return `<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><LastChange>${escapeXML(change)}</LastChange></e:property></e:propertyset>`;
  }
  private notify(sub: Subscription): void {
    if (sub.initial) return;
    sub.latest = this.eventBody(sub.service);
    if (sub.sending) return;
    sub.sending = true;
    void (async () => {
      // Coalesce updates while a slow subscriber is receiving the previous event.
      while (sub.latest && this.subscriptions.get(sub.sid) === sub && sub.expires > Date.now()) {
        const body = sub.latest;
        sub.latest = '';
        const seq = sub.seq;
        sub.seq = seq === 0xffffffff ? 1 : seq + 1;
        try {
          const response = await fetch(sub.callback, { method: 'NOTIFY', headers: { 'Content-Type': 'text/xml; charset="utf-8"', NT: 'upnp:event', NTS: 'upnp:propchange', SID: sub.sid, SEQ: String(seq), 'X-Fetch-No-Redirect': '1', 'X-Fetch-Timeout-Ms': '1500' }, body });
          if (!response.ok) this.subscriptions.delete(sub.sid);
        } catch { this.subscriptions.delete(sub.sid); }
      }
      sub.sending = false;
    })();
  }
  private publish(): void {
    this.purgeSubscriptions();
    for (const sub of this.subscriptions.values()) this.notify(sub);
  }
  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.serial(async () => {
        if (!this.socket) return;
        this.purgeSubscriptions();
        try {
          if (this.ownsPlayback && this.uri) {
            const before = this.eventBody('AVTransport');
            const state = await this.mina.getPlayState(this.config.account_id, this.config.device_id);
            if (this.ownsPlayback) {
              if (state.hasPosition) this.position = state.position;
              if (state.duration > 0) this.duration = state.duration;
              if (state.status === 1) this.stoppedHits = 0;
              else if ((state.status === 0 || state.status === 2) && this.transport === 'PLAYING' && Date.now() - this.playStartedAt > 10000 && ++this.stoppedHits >= 3) {
                this.transport = state.status === 2 ? 'PAUSED_PLAYBACK' : 'STOPPED';
              }
              if (before !== this.eventBody('AVTransport')) this.publish();
            }
          }
        } catch (e) { songloft.log.warn('[DLNA] Status read failed: ' + String(e)); }
        this.schedulePoll();
      }).catch(e => songloft.log.warn('[DLNA] ' + String(e)));
    }, 5000);
  }
}
