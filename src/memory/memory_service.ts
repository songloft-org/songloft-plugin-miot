/// <reference types="@songloft/plugin-sdk" />

import { MemoryEntityIndex, canonicalKeyForRecord } from './entity_index';
import { MemoryResolver } from './memory_resolver';
import { SongloftStorageMemoryAdapter } from './storage_adapter';
import type {
  MemoryFindResult,
  MemoryRecord,
  MemoryRecordInput,
  MemoryResolveResult,
  MemoryStorageAdapter,
  MemoryStoreSnapshot,
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
    return this.enqueueWrite('clear', async () => this.commitCandidate(new Map()));
  }

  getIndexStats(): { records: number; entities: number; aliases: number } {
    return {
      records: this.entityIndex.recordById.size,
      entities: this.entityIndex.entities.size,
      aliases: this.entityIndex.aliasIndex.size,
    };
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
    this.entityIndex.clear();
    this.initialized = false;
    this.storageHealthy = false;
    songloft.log.warn(`[VoiceMemoryV2] error fallback stage="${stage}" error="${String(error)}"`);
  }
}
