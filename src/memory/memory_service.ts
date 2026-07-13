/// <reference types="@songloft/plugin-sdk" />

import { SongloftStorageMemoryAdapter } from './storage_adapter';
import type {
  MemoryFindResult,
  MemoryRecord,
  MemoryRecordInput,
  MemoryStorageAdapter,
  MemoryStoreSnapshot,
} from './types';

const MAX_MEMORY_RECORDS = 200;

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

  constructor(adapter: MemoryStorageAdapter = new SongloftStorageMemoryAdapter()) {
    this.adapter = adapter;
  }

  async init(): Promise<void> {
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
      return Array.from(this.records.values());
    } catch (error) {
      this.records.clear();
      songloft.log.warn('[MemoryService] load failed, using empty memory: ' + String(error));
      return [];
    }
  }

  async save(): Promise<boolean> {
    try {
      const records = Array.from(this.records.values())
        .sort((a, b) => {
          const scoreA = a.successCount * 2 + a.hitCount - a.failureCount;
          const scoreB = b.successCount * 2 + b.hitCount - b.failureCount;
          if (scoreB !== scoreA) return scoreB - scoreA;
          return b.updatedAt.localeCompare(a.updatedAt);
        })
        .slice(0, MAX_MEMORY_RECORDS);

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
}
