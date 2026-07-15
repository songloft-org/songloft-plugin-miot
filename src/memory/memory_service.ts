/// <reference types="@songloft/plugin-sdk" />

import { MemoryEntityIndex, canonicalKeyForRecord } from './entity_index';
import { MemoryResolver } from './memory_resolver';
import { SongloftStorageMemoryAdapter } from './storage_adapter';
import type {
  MemoryAmbiguityRecord,
  MemoryEntityView,
  MemoryFindResult,
  MemoryMutationResult,
  MemoryRecord,
  MemoryRecordInput,
  MemoryResolveResult,
  MemoryStats,
  MemoryStorageAdapter,
  MemoryStoreSnapshot,
  MemoryUnclassifiedView,
} from './types';
import { DEFAULT_MEMORY_MAX_RECORDS, normalizeMemoryMaxRecords } from './types';

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function nowIso(): string {
  return new Date().toISOString();
}

function findById(records: Map<string, MemoryRecord>, id: string): MemoryRecord | null {
  for (const record of records.values()) {
    if (record.id === id) return record;
  }
  return null;
}

const AMBIGUITY_STORAGE_KEY = 'memory:v3:ambiguous';
const MAX_AMBIGUITY_RECORDS = 20;
const HIT_FLUSH_DELAY_MS = 5000;
const AMBIGUITY_FLUSH_DELAY_MS = 2000;
const BLOCKED_MANUAL_ALIASES = new Set([
  '歌', '音乐', '播放', '听歌', '暂停', '暂停播放', '暂停音乐', '停止', '停止播放', '停一下',
  '继续', '继续播放', '下一首', '上一首', '切歌', '换一首', '音量', '声音', '顺序播放', '随机播放',
  '单曲循环', '列表循环', 'pause', 'stop', 'next', 'previous',
]);

interface PendingHit {
  count: number;
  lastUsedAt: string;
  reason: string;
}

function localHitCount(record: MemoryRecord): number {
  return record.memoryHitCount ?? Math.max(0, record.successCount - 1);
}

export class MemoryService {
  private readonly adapter: MemoryStorageAdapter;
  private records: Map<string, MemoryRecord> = new Map();
  private readonly entityIndex = new MemoryEntityIndex();
  private readonly resolver = new MemoryResolver(this.entityIndex);
  private initialized = false;
  private storageHealthy = false;
  private maxRecords: number;
  private initPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private pendingHits = new Map<string, PendingHit>();
  private hitFlushTimer: any = null;
  private ambiguities: MemoryAmbiguityRecord[] = [];
  private ambiguitiesLoaded = false;
  private ambiguityStorageHealthy = false;
  private ambiguityFlushTimer: any = null;

  constructor(
    adapter: MemoryStorageAdapter = new SongloftStorageMemoryAdapter(),
    maxRecords: number = DEFAULT_MEMORY_MAX_RECORDS,
  ) {
    this.adapter = adapter;
    this.maxRecords = normalizeMemoryMaxRecords(maxRecords);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return await this.initPromise;
    this.initPromise = this.initialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async initialize(): Promise<void> {
    try {
      await this.load();
      this.initialized = this.storageHealthy;
    } catch (error) {
      this.enterDegradedState('init', error);
    }
  }

  async load(): Promise<MemoryRecord[]> {
    try {
      const result = await this.adapter.load();
      if ((result.status === 'read_error' || result.status === 'format_error') || !result.snapshot) {
        this.enterDegradedState(result.status, result.error || 'memory snapshot unavailable');
        return [];
      }

      this.storageHealthy = true;
      if (result.invalidRecordCount) {
        songloft.log.warn(`[VoiceMemoryV2] load ignored invalid records count=${result.invalidRecordCount}`);
      }

      const loaded = new Map(result.snapshot.records.map(record => [record.normalizedQuery, record]));
      const candidate = new Map(loaded);
      const evicted = this.enforceLimit(candidate);
      if (evicted > 0) {
        const saved = await this.persistCandidate(candidate);
        this.records = saved ? candidate : loaded;
      } else {
        this.records = loaded;
      }
      this.rebuildIndex();
      return Array.from(this.records.values());
    } catch (error) {
      this.enterDegradedState('load', error);
      return [];
    }
  }

  async save(): Promise<boolean> {
    return this.enqueueWrite('save', async () => this.commitCandidate(new Map(this.records)));
  }

  findByQuery(query: string): MemoryFindResult {
    try {
      if (!this.initialized) return null;
      const normalizedQuery = this.normalizeQuery(query);
      if (!normalizedQuery) return null;
      return this.records.get(normalizedQuery) ?? null;
    } catch (error) {
      songloft.log.warn('[VoiceMemoryV2] error fallback stage="find_exact" error="' + String(error) + '"');
      return null;
    }
  }

  resolveEntity(query: string): MemoryResolveResult {
    try {
      if (!this.initialized) return { status: 'miss', reason: 'memory_not_initialized', candidateCount: 0 };
      return this.resolver.resolve(query);
    } catch (error) {
      songloft.log.warn('[VoiceMemoryV2] error fallback stage="resolve" error="' + String(error) + '"');
      return { status: 'miss', reason: 'resolver_error', candidateCount: 0 };
    }
  }

  async recordSuccess(input: MemoryRecordInput): Promise<boolean> {
    return this.enqueueWrite('recordSuccess', async () => {
      const normalizedQuery = this.normalizeQuery(input.query);
      if (!normalizedQuery) return false;

      const candidate = new Map(this.records);
      const timestamp = nowIso();
      const matched = input.matchedRecordId ? findById(candidate, input.matchedRecordId) : null;
      if (matched && matched.normalizedQuery !== normalizedQuery) {
        candidate.set(matched.normalizedQuery, this.upgradeRecord({
          ...matched,
          memoryHitCount: input.memoryHitReason
            ? (matched.memoryHitCount ?? Math.max(0, matched.successCount - 1))
            : matched.memoryHitCount,
          savedAiCalls: input.memoryHitReason
            ? (matched.savedAiCalls ?? matched.memoryHitCount ?? Math.max(0, matched.successCount - 1))
            : matched.savedAiCalls,
          hitCount: matched.hitCount + 1,
          successCount: matched.successCount + 1,
          updatedAt: timestamp,
          lastUsedAt: timestamp,
        }));
      }

      const existing = candidate.get(normalizedQuery);
      const base: MemoryRecord = {
        id: existing?.id ?? `memory_${hashString(normalizedQuery)}`,
        query: input.query,
        normalizedQuery,
        type: input.type,
        songId: input.songId,
        songName: input.songName,
        artist: input.artist,
        playlistId: input.playlistId,
        playlistName: input.playlistName,
        songIndex: input.songIndex,
        canonicalKey: existing?.canonicalKey ?? matched?.canonicalKey,
        manualAlias: existing?.manualAlias,
        aliasSource: existing?.aliasSource ?? 'auto',
        memoryHitCount: (existing?.memoryHitCount ?? 0) + (input.memoryHitReason ? 1 : 0),
        savedAiCalls: (existing?.savedAiCalls ?? 0) + (input.memoryHitReason ? 1 : 0),
        lastHitReason: input.memoryHitReason ?? existing?.lastHitReason,
        hitCount: (existing?.hitCount ?? 0) + 1,
        successCount: (existing?.successCount ?? 0) + 1,
        failureCount: existing?.failureCount ?? 0,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        lastUsedAt: timestamp,
      };
      candidate.set(normalizedQuery, this.upgradeRecord(base));
      this.enforceLimit(candidate);
      return this.commitCandidate(candidate);
    });
  }

  async recordFailure(query: string, matchedRecordId?: string): Promise<boolean> {
    return this.enqueueWrite('recordFailure', async () => {
      const normalizedQuery = this.normalizeQuery(query);
      if (!normalizedQuery) return false;
      const candidate = new Map(this.records);
      const existing = candidate.get(normalizedQuery) ?? (matchedRecordId ? findById(candidate, matchedRecordId) : null);
      if (!existing) return false;
      const timestamp = nowIso();
      candidate.set(existing.normalizedQuery, this.upgradeRecord({
        ...existing,
        hitCount: existing.hitCount + 1,
        failureCount: existing.failureCount + 1,
        updatedAt: timestamp,
        lastUsedAt: timestamp,
      }));
      return this.commitCandidate(candidate);
    });
  }

  normalizeQuery(query: string): string {
    try {
      return (query || '')
        .toLowerCase()
        .replace(/[\s　《》【】「」『』〔〕〈〉（）()\[\]{}，,。.、·!！?？~～—\-_:：;；'"`]/g, '')
        .trim();
    } catch {
      return '';
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isStorageHealthy(): boolean {
    return this.storageHealthy;
  }

  async setMaxRecords(maxRecords: number): Promise<boolean> {
    const normalized = normalizeMemoryMaxRecords(maxRecords);
    if (normalized === this.maxRecords) return true;
    return this.enqueueWrite('setMaxRecords', async () => {
      this.maxRecords = normalized;
      if (!this.initialized) return true;
      const candidate = new Map(this.records);
      const evicted = this.enforceLimit(candidate);
      return evicted === 0 ? true : this.commitCandidate(candidate);
    });
  }

  getMaxRecords(): number {
    return this.maxRecords;
  }

  list(): MemoryRecord[] {
    return Array.from(this.records.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  count(): number {
    return this.records.size;
  }

  findById(id: string): MemoryRecord | null {
    return findById(this.records, id);
  }

  async trimToLimit(): Promise<boolean> {
    return this.enqueueWrite('trimToLimit', async () => {
      const candidate = new Map(this.records);
      const evicted = this.enforceLimit(candidate);
      return evicted === 0 ? true : this.commitCandidate(candidate);
    });
  }

  async deleteById(id: string): Promise<boolean> {
    return this.enqueueWrite('deleteById', async () => {
      const candidate = new Map(this.records);
      const record = findById(candidate, id);
      if (!record) return false;
      candidate.delete(record.normalizedQuery);
      return this.commitCandidate(candidate);
    });
  }

  async clear(): Promise<boolean> {
    return this.enqueueWrite('clear', async () => {
      const saved = await this.commitCandidate(new Map());
      if (saved) this.pendingHits.clear();
      return saved;
    });
  }

  queueHit(recordId: string, reason: string): void {
    try {
      if (!this.initialized || !this.findById(recordId)) return;
      const timestamp = nowIso();
      const pending = this.pendingHits.get(recordId);
      this.pendingHits.set(recordId, {
        count: (pending?.count ?? 0) + 1,
        lastUsedAt: timestamp,
        reason,
      });
      if (!this.hitFlushTimer) {
        this.hitFlushTimer = setTimeout(() => {
          this.hitFlushTimer = null;
          void this.flushPendingHits();
        }, HIT_FLUSH_DELAY_MS);
      }
    } catch (error) {
      songloft.log.warn('[VoiceMemoryV3] error stage="queue_hit" error="' + String(error) + '"');
    }
  }

  async flushPendingHits(): Promise<boolean> {
    if (this.hitFlushTimer) {
      clearTimeout(this.hitFlushTimer);
      this.hitFlushTimer = null;
    }
    if (this.pendingHits.size === 0) return true;
    const batch = this.pendingHits;
    this.pendingHits = new Map();
    const saved = await this.enqueueWrite('flushHits', async () => {
      const candidate = new Map(this.records);
      for (const [recordId, pending] of batch) {
        const record = findById(candidate, recordId);
        if (!record) continue;
        candidate.set(record.normalizedQuery, this.upgradeRecord({
          ...record,
          hitCount: record.hitCount + pending.count,
          successCount: record.successCount + pending.count,
          memoryHitCount: (record.memoryHitCount ?? 0) + pending.count,
          savedAiCalls: (record.savedAiCalls ?? 0) + pending.count,
          lastHitReason: pending.reason,
          updatedAt: pending.lastUsedAt,
          lastUsedAt: pending.lastUsedAt,
        }));
      }
      return this.commitCandidate(candidate);
    });
    if (!saved) {
      for (const [recordId, pending] of batch) {
        const current = this.pendingHits.get(recordId);
        this.pendingHits.set(recordId, {
          count: (current?.count ?? 0) + pending.count,
          lastUsedAt: current?.lastUsedAt && current.lastUsedAt > pending.lastUsedAt ? current.lastUsedAt : pending.lastUsedAt,
          reason: current?.reason ?? pending.reason,
        });
      }
    }
    return saved;
  }

  listEntities(): MemoryEntityView[] {
    const views: MemoryEntityView[] = [];
    for (const entity of this.entityIndex.entities.values()) {
      const records = Array.from(entity.recordIds)
        .map(id => this.entityIndex.recordById.get(id))
        .filter((record): record is MemoryRecord => !!record);
      if (records.length === 0) continue;
      const aliases = records.map(record => {
        const pending = this.pendingHits.get(record.id)?.count ?? 0;
        return {
          id: record.id,
          query: record.query || record.normalizedQuery,
          normalizedQuery: record.normalizedQuery,
          manualAlias: record.manualAlias === true,
          aliasSource: record.aliasSource === 'manual' ? 'manual' as const : 'auto' as const,
          hitCount: record.hitCount + pending,
          localHitCount: localHitCount(record) + pending,
          lastUsedAt: this.pendingHits.get(record.id)?.lastUsedAt ?? record.lastUsedAt,
          updatedAt: this.pendingHits.get(record.id)?.lastUsedAt ?? record.updatedAt,
        };
      }).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
      views.push({
        canonicalKey: entity.canonicalKey,
        songId: entity.representative.songId,
        songName: entity.representative.songName || '',
        artist: entity.representative.artist || '',
        queryCount: records.length,
        localHitCount: aliases.reduce((sum, item) => sum + item.localHitCount, 0),
        successCount: records.reduce((sum, record) => sum + record.successCount, 0),
        failureCount: records.reduce((sum, record) => sum + record.failureCount, 0),
        lastUsedAt: aliases[0]?.lastUsedAt || entity.representative.lastUsedAt,
        updatedAt: aliases[0]?.updatedAt || entity.representative.updatedAt,
        aliases,
      });
    }
    return views.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  listUnclassified(): MemoryUnclassifiedView[] {
    return Array.from(this.records.values())
      .filter(record => !this.entityIndex.derivedByRecordId.has(record.id))
      .map(record => ({
        id: record.id,
        query: record.query || record.normalizedQuery,
        normalizedQuery: record.normalizedQuery,
        type: record.type,
        songName: record.songName || '',
        artist: record.artist || '',
        hitCount: record.hitCount,
        successCount: record.successCount,
        failureCount: record.failureCount,
        lastUsedAt: record.lastUsedAt,
        updatedAt: record.updatedAt,
      }))
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  getStats(): MemoryStats {
    const records = Array.from(this.records.values());
    let localHits = 0;
    let savedAiCalls = 0;
    for (const record of records) {
      const pending = this.pendingHits.get(record.id)?.count ?? 0;
      localHits += localHitCount(record) + pending;
      savedAiCalls += (record.savedAiCalls ?? localHitCount(record)) + pending;
    }
    return {
      recordCount: records.length,
      entityCount: this.entityIndex.entities.size,
      unclassifiedCount: this.listUnclassified().length,
      localHitCount: localHits,
      savedAiCalls,
      ambiguousCount: this.ambiguities.length,
    };
  }

  async addManualAlias(canonicalKey: string, alias: string): Promise<MemoryMutationResult> {
    const trimmed = (alias || '').trim();
    const length = Array.from(trimmed).length;
    const normalizedQuery = this.normalizeQuery(trimmed);
    if (!normalizedQuery) return { ok: false, error: '别名不能为空' };
    if (length < 2 || length > 30) return { ok: false, error: '别名长度必须为 2 到 30 个字符' };
    if (BLOCKED_MANUAL_ALIASES.has(normalizedQuery)) return { ok: false, error: '该词过于宽泛或属于固定控制命令' };
    const entity = this.entityIndex.entities.get(canonicalKey);
    if (!entity) return { ok: false, error: '未找到歌曲实体' };
    if (this.records.has(normalizedQuery) || this.entityIndex.aliasIndex.has(normalizedQuery) || entity.aliases.includes(normalizedQuery)) {
      return { ok: false, error: '该别名已存在' };
    }

    let created: MemoryRecord | undefined;
    const ok = await this.enqueueWrite('addManualAlias', async () => {
      const currentEntity = this.entityIndex.entities.get(canonicalKey);
      if (!currentEntity || this.records.has(normalizedQuery) || this.entityIndex.aliasIndex.has(normalizedQuery)) return false;
      const source = currentEntity.representative;
      const timestamp = nowIso();
      created = this.upgradeRecord({
        ...source,
        id: `memory_${hashString(normalizedQuery)}`,
        query: trimmed,
        normalizedQuery,
        canonicalKey,
        manualAlias: true,
        aliasSource: 'manual',
        hitCount: 0,
        successCount: 0,
        failureCount: 0,
        memoryHitCount: 0,
        savedAiCalls: 0,
        lastHitReason: undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastUsedAt: timestamp,
      });
      const candidate = new Map(this.records);
      candidate.set(normalizedQuery, created);
      return this.commitCandidate(candidate);
    });
    return ok && created ? { ok: true, record: created } : { ok: false, error: '保存别名失败，原记忆未修改' };
  }

  async deleteEntityAlias(canonicalKey: string, recordId: string): Promise<boolean> {
    return this.enqueueWrite('deleteEntityAlias', async () => {
      const derived = this.entityIndex.derivedByRecordId.get(recordId);
      if (!derived || derived.canonicalKey !== canonicalKey) return false;
      const candidate = new Map(this.records);
      candidate.delete(derived.record.normalizedQuery);
      const saved = await this.commitCandidate(candidate);
      if (saved) this.pendingHits.delete(recordId);
      return saved;
    });
  }

  async deleteEntity(canonicalKey: string): Promise<boolean> {
    return this.enqueueWrite('deleteEntity', async () => {
      const entity = this.entityIndex.entities.get(canonicalKey);
      if (!entity) return false;
      const candidate = new Map(this.records);
      for (const recordId of entity.recordIds) {
        const record = findById(candidate, recordId);
        if (record) candidate.delete(record.normalizedQuery);
      }
      const saved = await this.commitCandidate(candidate);
      if (saved) for (const recordId of entity.recordIds) this.pendingHits.delete(recordId);
      return saved;
    });
  }

  async listAmbiguities(): Promise<MemoryAmbiguityRecord[]> {
    await this.ensureAmbiguitiesLoaded();
    return this.ambiguities.map(item => ({ ...item, candidates: item.candidates.map(candidate => ({ ...candidate })) }));
  }

  async recordAmbiguity(query: string, result: MemoryResolveResult): Promise<void> {
    try {
      await this.ensureAmbiguitiesLoaded();
      if (!this.ambiguityStorageHealthy) return;
      const normalizedQuery = this.normalizeQuery(query);
      if (!normalizedQuery) return;
      const timestamp = nowIso();
      const existing = this.ambiguities.find(item => item.normalizedQuery === normalizedQuery);
      const record: MemoryAmbiguityRecord = {
        query,
        normalizedQuery,
        reason: result.reason || 'ambiguous',
        candidateCount: result.candidateCount ?? result.candidates?.length ?? 0,
        candidates: (result.candidates || []).slice(0, 5),
        lastSeenAt: timestamp,
        occurrenceCount: (existing?.occurrenceCount ?? 0) + 1,
      };
      this.ambiguities = [record, ...this.ambiguities.filter(item => item.normalizedQuery !== normalizedQuery)]
        .slice(0, MAX_AMBIGUITY_RECORDS);
      this.scheduleAmbiguitySave();
    } catch (error) {
      songloft.log.warn('[VoiceMemoryV3] error stage="record_ambiguous" error="' + String(error) + '"');
    }
  }

  async clearAmbiguities(): Promise<boolean> {
    await this.ensureAmbiguitiesLoaded();
    if (!this.ambiguityStorageHealthy) return false;
    this.ambiguities = [];
    return this.saveAmbiguities();
  }

  getIndexStats(): { records: number; entities: number; aliases: number } {
    return {
      records: this.entityIndex.recordById.size,
      entities: this.entityIndex.entities.size,
      aliases: this.entityIndex.aliasIndex.size,
    };
  }

  private async ensureAmbiguitiesLoaded(): Promise<void> {
    if (this.ambiguitiesLoaded) return;
    this.ambiguitiesLoaded = true;
    try {
      const raw = await songloft.storage.get(AMBIGUITY_STORAGE_KEY);
      if (raw === null || raw === undefined || raw === '') {
        this.ambiguities = [];
        this.ambiguityStorageHealthy = true;
        return;
      }
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || typeof parsed !== 'object' || (parsed as any).version !== 1 || !Array.isArray((parsed as any).records)) {
        throw new Error('invalid ambiguity snapshot');
      }
      this.ambiguities = (parsed as any).records.filter((item: any) =>
        item && typeof item.query === 'string' && typeof item.normalizedQuery === 'string' &&
        typeof item.reason === 'string' && typeof item.candidateCount === 'number' &&
        Array.isArray(item.candidates) && typeof item.lastSeenAt === 'string' &&
        typeof item.occurrenceCount === 'number',
      ).slice(0, MAX_AMBIGUITY_RECORDS);
      this.ambiguityStorageHealthy = true;
    } catch (error) {
      this.ambiguities = [];
      this.ambiguityStorageHealthy = false;
      songloft.log.warn('[VoiceMemoryV3] error stage="load_ambiguous" error="' + String(error) + '"');
    }
  }

  private scheduleAmbiguitySave(): void {
    if (this.ambiguityFlushTimer) return;
    this.ambiguityFlushTimer = setTimeout(() => {
      this.ambiguityFlushTimer = null;
      void this.saveAmbiguities();
    }, AMBIGUITY_FLUSH_DELAY_MS);
  }

  private async saveAmbiguities(): Promise<boolean> {
    if (!this.ambiguityStorageHealthy) return false;
    try {
      await songloft.storage.set(AMBIGUITY_STORAGE_KEY, JSON.stringify({
        version: 1,
        records: this.ambiguities.slice(0, MAX_AMBIGUITY_RECORDS),
        updatedAt: nowIso(),
      }));
      return true;
    } catch (error) {
      songloft.log.warn('[VoiceMemoryV3] error stage="save_ambiguous" error="' + String(error) + '"');
      return false;
    }
  }

  private upgradeRecord(record: MemoryRecord): MemoryRecord {
    const canonicalKey = canonicalKeyForRecord(record);
    if (!canonicalKey) return record;
    return { ...record, recordVersion: 2, canonicalKey };
  }

  private async commitCandidate(candidate: Map<string, MemoryRecord>): Promise<boolean> {
    if (!this.storageHealthy) {
      songloft.log.warn('[VoiceMemoryV2] fallback stage="write" reason="storage_unavailable"');
      return false;
    }
    this.enforceLimit(candidate);
    const saved = await this.persistCandidate(candidate);
    if (!saved) return false;
    this.records = candidate;
    this.rebuildIndex();
    return true;
  }

  private async persistCandidate(candidate: Map<string, MemoryRecord>): Promise<boolean> {
    const snapshot: MemoryStoreSnapshot = {
      version: 1,
      records: Array.from(candidate.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      updatedAt: nowIso(),
    };
    try {
      return await this.adapter.save(snapshot);
    } catch (error) {
      songloft.log.warn('[VoiceMemoryV2] error fallback stage="save" error="' + String(error) + '"');
      return false;
    }
  }

  private enqueueWrite(label: string, operation: () => Promise<boolean>): Promise<boolean> {
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      try {
        return await operation();
      } catch (error) {
        songloft.log.warn(`[VoiceMemoryV2] error fallback stage="${label}" error="${String(error)}"`);
        return false;
      }
    });
    this.writeQueue = task.then(() => undefined, error => {
      songloft.log.warn(`[VoiceMemoryV2] error fallback stage="write_queue" error="${String(error)}"`);
    });
    return task;
  }

  private enforceLimit(records: Map<string, MemoryRecord>): number {
    const overflow = records.size - this.maxRecords;
    if (overflow <= 0) return 0;
    const oldest = Array.from(records.values()).sort((a, b) => {
      const lastUsed = a.lastUsedAt.localeCompare(b.lastUsedAt);
      if (lastUsed !== 0) return lastUsed;
      const updated = a.updatedAt.localeCompare(b.updatedAt);
      if (updated !== 0) return updated;
      return a.createdAt.localeCompare(b.createdAt);
    }).slice(0, overflow);
    for (const record of oldest) records.delete(record.normalizedQuery);
    songloft.log.info(`[MemoryService] evicted ${oldest.length} old record(s), limit=${this.maxRecords}`);
    return oldest.length;
  }

  private rebuildIndex(): void {
    this.entityIndex.rebuild(this.records.values());
    const stats = this.getIndexStats();
    songloft.log.info(`[VoiceMemoryV2] index_rebuilt records=${stats.records} entities=${stats.entities} aliases=${stats.aliases}`);
  }

  private enterDegradedState(stage: string, error: unknown): void {
    this.records.clear();
    this.pendingHits.clear();
    this.entityIndex.clear();
    this.initialized = false;
    this.storageHealthy = false;
    songloft.log.warn(`[VoiceMemoryV2] error fallback stage="${stage}" error="${String(error)}"`);
  }
}
