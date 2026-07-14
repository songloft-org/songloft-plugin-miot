/// <reference types="@songloft/plugin-sdk" />

import { SongloftStorageMemoryAdapter } from './storage_adapter';
import type {
  MemoryFindResult,
  MemoryRecord,
  MemoryRecordInput,
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

export class MemoryService {
  private adapter: MemoryStorageAdapter;
  private records: Map<string, MemoryRecord> = new Map();
  private initialized = false;
  private maxRecords: number;
  private initPromise: Promise<void> | null = null;

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
      this.initialized = true;
    } catch (error) {
      this.records.clear();
      this.initialized = false;
      songloft.log.warn('[MemoryService] init failed, memory disabled for this run: ' + String(error));
    }
  }

  async load(): Promise<MemoryRecord[]> {
    try {
      const snapshot = await this.adapter.load();
      this.records = new Map(snapshot.records.map(record => [record.normalizedQuery, record]));
      const evicted = this.enforceLimit();
      if (evicted > 0) {
        await this.save();
      }
      return Array.from(this.records.values());
    } catch (error) {
      this.records.clear();
      songloft.log.warn('[MemoryService] load failed, using empty memory: ' + String(error));
      return [];
    }
  }

  async save(): Promise<boolean> {
    try {
      this.enforceLimit();
      const records = this.list();

      const snapshot: MemoryStoreSnapshot = {
        version: 1,
        records,
        updatedAt: nowIso(),
      };
      return await this.adapter.save(snapshot);
    } catch (error) {
      songloft.log.warn('[MemoryService] save failed, memory update skipped: ' + String(error));
      return false;
    }
  }

  findByQuery(query: string): MemoryFindResult {
    try {
      const normalizedQuery = this.normalizeQuery(query);
      if (!normalizedQuery) return null;
      return this.records.get(normalizedQuery) ?? null;
    } catch (error) {
      songloft.log.warn('[MemoryService] findByQuery failed: ' + String(error));
      return null;
    }
  }

  async recordSuccess(input: MemoryRecordInput): Promise<boolean> {
    try {
      const normalizedQuery = this.normalizeQuery(input.query);
      if (!normalizedQuery) return false;

      const existing = this.records.get(normalizedQuery);
      const timestamp = nowIso();
      const record: MemoryRecord = {
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
        hitCount: (existing?.hitCount ?? 0) + 1,
        successCount: (existing?.successCount ?? 0) + 1,
        failureCount: existing?.failureCount ?? 0,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        lastUsedAt: timestamp,
      };

      this.records.set(normalizedQuery, record);
      return await this.save();
    } catch (error) {
      songloft.log.warn('[MemoryService] recordSuccess failed, memory update skipped: ' + String(error));
      return false;
    }
  }

  async recordFailure(query: string): Promise<boolean> {
    try {
      const normalizedQuery = this.normalizeQuery(query);
      if (!normalizedQuery) return false;

      const existing = this.records.get(normalizedQuery);
      if (!existing) return false;

      const timestamp = nowIso();
      this.records.set(normalizedQuery, {
        ...existing,
        hitCount: existing.hitCount + 1,
        failureCount: existing.failureCount + 1,
        updatedAt: timestamp,
        lastUsedAt: timestamp,
      });
      return await this.save();
    } catch (error) {
      songloft.log.warn('[MemoryService] recordFailure failed, memory update skipped: ' + String(error));
      return false;
    }
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

  setMaxRecords(maxRecords: number): void {
    this.maxRecords = normalizeMemoryMaxRecords(maxRecords);
    this.enforceLimit();
  }

  getMaxRecords(): number {
    return this.maxRecords;
  }

  list(): MemoryRecord[] {
    return Array.from(this.records.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  count(): number {
    return this.records.size;
  }

  findById(id: string): MemoryRecord | null {
    for (const record of this.records.values()) {
      if (record.id === id) return record;
    }
    return null;
  }

  async trimToLimit(): Promise<boolean> {
    try {
      this.enforceLimit();
      return await this.save();
    } catch (error) {
      songloft.log.warn('[MemoryService] trimToLimit failed: ' + String(error));
      return false;
    }
  }

  async deleteById(id: string): Promise<boolean> {
    try {
      const record = this.findById(id);
      if (!record) return false;

      this.records.delete(record.normalizedQuery);
      const saved = await this.save();
      if (!saved) {
        this.records.set(record.normalizedQuery, record);
      }
      return saved;
    } catch (error) {
      songloft.log.warn('[MemoryService] deleteById failed: ' + String(error));
      return false;
    }
  }

  async clear(): Promise<boolean> {
    try {
      const previous = new Map(this.records);
      this.records.clear();
      const saved = await this.save();
      if (!saved) {
        this.records = previous;
      }
      return saved;
    } catch (error) {
      songloft.log.warn('[MemoryService] clear failed: ' + String(error));
      return false;
    }
  }

  private enforceLimit(): number {
    const overflow = this.records.size - this.maxRecords;
    if (overflow <= 0) return 0;

    const oldest = Array.from(this.records.values())
      .sort((a, b) => {
        const lastUsedCompare = a.lastUsedAt.localeCompare(b.lastUsedAt);
        if (lastUsedCompare !== 0) return lastUsedCompare;
        const updatedCompare = a.updatedAt.localeCompare(b.updatedAt);
        if (updatedCompare !== 0) return updatedCompare;
        return a.createdAt.localeCompare(b.createdAt);
      })
      .slice(0, overflow);

    for (const record of oldest) {
      this.records.delete(record.normalizedQuery);
    }
    songloft.log.info(`[MemoryService] evicted ${oldest.length} old record(s), limit=${this.maxRecords}`);
    return oldest.length;
  }
}
