/// <reference types="@songloft/plugin-sdk" />

import type {
  MemoryLoadResult,
  MemoryRecord,
  MemoryStoreSnapshot,
  MemoryStorageAdapter as MemoryStorageAdapterContract,
} from './types';

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
    typeof value.lastUsedAt === 'string' &&
    (value.query === undefined || typeof value.query === 'string') &&
    (value.recordVersion === undefined || value.recordVersion === 2) &&
    (value.canonicalKey === undefined || typeof value.canonicalKey === 'string') &&
    (value.manualAlias === undefined || typeof value.manualAlias === 'boolean') &&
    (value.aliasSource === undefined || value.aliasSource === 'auto' || value.aliasSource === 'manual') &&
    (value.memoryHitCount === undefined || typeof value.memoryHitCount === 'number') &&
    (value.savedAiCalls === undefined || typeof value.savedAiCalls === 'number') &&
    (value.lastHitReason === undefined || typeof value.lastHitReason === 'string')
  );
}

function parseSnapshot(raw: unknown): MemoryLoadResult {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return { status: 'format_error', error: String(error) };
  }

  if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records)) {
    return { status: 'format_error', error: 'invalid memory snapshot envelope' };
  }

  const records = parsed.records.filter(isMemoryRecord);
  if (parsed.records.length > 0 && records.length === 0) {
    return { status: 'format_error', error: 'memory snapshot contains no valid records' };
  }
  return {
    status: 'ok',
    snapshot: {
      version: 1,
      records,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    },
    invalidRecordCount: parsed.records.length - records.length,
  };
}

export class SongloftStorageMemoryAdapter implements MemoryStorageAdapterContract {
  async load(): Promise<MemoryLoadResult> {
    try {
      const raw = await songloft.storage.get(MEMORY_STORAGE_KEY);
      if (raw === null || raw === undefined || raw === '') {
        return { status: 'missing', snapshot: emptySnapshot() };
      }
      return parseSnapshot(raw);
    } catch (error) {
      return { status: 'read_error', error: String(error) };
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
