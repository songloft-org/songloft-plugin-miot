/// <reference types="@songloft/plugin-sdk" />

import type { MemoryRecord, MemoryStoreSnapshot, MemoryStorageAdapter as MemoryStorageAdapterContract } from './types';

const MEMORY_STORAGE_KEY = 'memory:v1:records';

function emptySnapshot(): MemoryStoreSnapshot {
  return {
    version: 1,
    records: [],
    updatedAt: new Date().toISOString(),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!isObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.normalizedQuery === 'string' &&
    (value.type === 'play_song' || value.type === 'play_playlist') &&
    typeof value.hitCount === 'number' &&
    typeof value.successCount === 'number' &&
    typeof value.failureCount === 'number' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.lastUsedAt === 'string'
  );
}

function parseSnapshot(raw: unknown): MemoryStoreSnapshot {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records)) {
      return emptySnapshot();
    }

    return {
      version: 1,
      records: parsed.records.filter(isMemoryRecord),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return emptySnapshot();
  }
}

export class SongloftStorageMemoryAdapter implements MemoryStorageAdapterContract {
  async load(): Promise<MemoryStoreSnapshot> {
    try {
      const raw = await songloft.storage.get(MEMORY_STORAGE_KEY);
      if (raw === null || raw === undefined || raw === '') {
        return emptySnapshot();
      }
      return parseSnapshot(raw);
    } catch (error) {
      songloft.log.warn('[MemoryStorage] load failed, using empty memory: ' + String(error));
      return emptySnapshot();
    }
  }

  async save(snapshot: MemoryStoreSnapshot): Promise<boolean> {
    try {
      await songloft.storage.set(MEMORY_STORAGE_KEY, JSON.stringify(snapshot));
      return true;
    } catch (error) {
      songloft.log.warn('[MemoryStorage] save failed, memory update skipped: ' + String(error));
      return false;
    }
  }
}
