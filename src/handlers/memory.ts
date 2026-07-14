// MIoT 智能音箱插件 - 智能记忆调试 Handler

import { jsonResponse, parseQuery } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import { MemoryService } from '../memory';
import type { ConfigManager } from '../config/manager';
import type { MemoryLoadResult, MemoryRecord, MemoryStorageAdapter, MemoryStoreSnapshot } from '../memory';
import { runMemoryV2SelfTest } from '../memory/self_test';

const MEMORY_STORAGE_KEY = 'memory:v1:records';

type SelfTestStep =
  | 'start'
  | 'load-original'
  | 'init'
  | 'recordSuccess'
  | 'write'
  | 'read'
  | 'recordFailure'
  | 'restore'
  | 'done';

interface ErrorDetails {
  name: string;
  message: string;
  stack: string[];
}

interface StepResult {
  ok: boolean;
  message: string;
  error?: ErrorDetails;
}

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
    (value.canonicalKey === undefined || typeof value.canonicalKey === 'string')
  );
}

function parseSnapshot(raw: unknown): MemoryStoreSnapshot {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records)) {
    throw new Error('invalid memory snapshot envelope');
  }
  const records = parsed.records.filter(isMemoryRecord);
  if (parsed.records.length > 0 && records.length === 0) {
    throw new Error('memory snapshot contains no valid records');
  }
  return {
    version: 1,
    records,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

function normalizeErrorText(message: string): string {
  const knownMessages: Record<string, string> = {
    '缂哄皯璁よ瘉淇℃伅': '缺少认证信息',
  };
  let normalized = message;
  for (const raw of Object.keys(knownMessages)) {
    normalized = normalized.split(raw).join(knownMessages[raw]);
  }
  return normalized;
}

function getErrorName(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  if (isObject(error) && typeof error.name === 'string') return error.name;
  return typeof error;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return normalizeErrorText(error.message || '未知错误');
  if (isObject(error) && typeof error.message === 'string') return normalizeErrorText(error.message);
  if (typeof error === 'string') return normalizeErrorText(error);
  return '未知错误';
}

function getErrorStack(error: unknown): string[] {
  if (error instanceof Error && typeof error.stack === 'string') {
    return error.stack
      .split('\n')
      .slice(0, 3)
      .map(line => normalizeErrorText(line.trim()))
      .filter(line => line.length > 0);
  }
  if (isObject(error) && typeof error.stack === 'string') {
    return error.stack
      .split('\n')
      .slice(0, 3)
      .map(line => normalizeErrorText(line.trim()))
      .filter(line => line.length > 0);
  }
  return [];
}

function toErrorDetails(error: unknown): ErrorDetails {
  return {
    name: getErrorName(error),
    message: getErrorMessage(error),
    stack: getErrorStack(error),
  };
}

function logStep(step: SelfTestStep, status: 'success' | 'failed' | 'info', message: string): void {
  const line = `[MemorySelfTest] ${step} ${status}: ${message}`;
  if (status === 'failed') {
    songloft.log.warn(line);
  } else {
    songloft.log.info(line);
  }
}

function makeResponse(ok: boolean, step: SelfTestStep, message: string, details: Record<string, unknown>) {
  return jsonResponse({
    ok,
    step,
    message,
    details,
  });
}

class SelfTestStorageAdapter implements MemoryStorageAdapter {
  private lastError: ErrorDetails | null = null;

  getLastError(): ErrorDetails | null {
    return this.lastError;
  }

  clearLastError(): void {
    this.lastError = null;
  }

  async load(): Promise<MemoryLoadResult> {
    let raw: unknown;
    try {
      this.clearLastError();
      raw = await songloft.storage.get(MEMORY_STORAGE_KEY);
    } catch (error) {
      this.lastError = toErrorDetails(error);
      return { status: 'read_error', error: this.lastError.message };
    }
    if (raw === null || raw === undefined || raw === '') {
      return { status: 'missing', snapshot: emptySnapshot() };
    }
    try {
      return { status: 'ok', snapshot: parseSnapshot(raw) };
    } catch (error) {
      this.lastError = toErrorDetails(error);
      return { status: 'format_error', error: this.lastError.message };
    }
  }

  async save(snapshot: MemoryStoreSnapshot): Promise<boolean> {
    try {
      this.clearLastError();
      await songloft.storage.set(MEMORY_STORAGE_KEY, JSON.stringify(snapshot));
      return true;
    } catch (error) {
      this.lastError = toErrorDetails(error);
      throw error;
    }
  }
}

/**
 * 注册智能记忆调试路由
 * GET /memory/self-test -> 验证 songloft.storage 读写智能记忆数据
 */
export function registerMemoryHandlers(
  router: Router,
  memoryService: MemoryService,
  configManager: ConfigManager,
): void {
  const ensureMemoryReady = async (): Promise<void> => {
    const config = await configManager.getConfig();
    await memoryService.setMaxRecords(config.voice_memory_max_records);
    await memoryService.init();
  };

  router.get('/memory', async (_req: HTTPRequest) => {
    try {
      await ensureMemoryReady();
      const config = await configManager.getConfig();
      const records = memoryService.list().map(record => ({
        id: record.id,
        query: record.query || record.normalizedQuery,
        normalizedQuery: record.normalizedQuery,
        type: record.type,
        songId: record.songId,
        songName: record.songName || '',
        artist: record.artist || '',
        playlistId: record.playlistId,
        playlistName: record.playlistName,
        songIndex: record.songIndex,
        hitCount: record.hitCount,
        successCount: record.successCount,
        failureCount: record.failureCount,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastUsedAt: record.lastUsedAt,
      }));
      return jsonResponse({
        success: true,
        data: {
          enabled: config.voice_memory_enabled,
          max_records: config.voice_memory_max_records,
          count: records.length,
          records,
        },
      });
    } catch (error) {
      songloft.log.warn('[MemoryHandler] list failed: ' + String(error));
      return jsonResponse({ success: false, error: '读取语音记忆失败' }, 500);
    }
  });

  router.delete('/memory', async (req: HTTPRequest) => {
    try {
      await ensureMemoryReady();
      const query = parseQuery(req.query);
      const id = query.id;
      if (!id) {
        return jsonResponse({ success: false, error: '缺少记忆 id' }, 400);
      }
      if (!memoryService.findById(id)) {
        return jsonResponse({ success: false, error: '未找到该条记忆' }, 404);
      }
      if (!(await memoryService.deleteById(id))) {
        return jsonResponse({ success: false, error: '删除记忆失败，原记录已保留' }, 500);
      }
      return jsonResponse({ success: true, data: { id, count: memoryService.count() } });
    } catch (error) {
      songloft.log.warn('[MemoryHandler] delete failed: ' + String(error));
      return jsonResponse({ success: false, error: '删除记忆失败' }, 500);
    }
  });

  router.delete('/memory/all', async (_req: HTTPRequest) => {
    try {
      await ensureMemoryReady();
      if (!(await memoryService.clear())) {
        return jsonResponse({ success: false, error: '清空记忆失败，原记录已保留' }, 500);
      }
      return jsonResponse({ success: true, data: { count: 0 } });
    } catch (error) {
      songloft.log.warn('[MemoryHandler] clear failed: ' + String(error));
      return jsonResponse({ success: false, error: '清空记忆失败' }, 500);
    }
  });

  router.get('/memory/self-test', async (req: HTTPRequest) => {
    const adapter = new SelfTestStorageAdapter();
    const service = new MemoryService(adapter);
    const query = 'smart memory runtime self test';
    const testMemory = {
      query,
      type: 'play_song' as const,
      songId: 100000001,
      songName: 'Memory Self Test Song',
      artist: 'Memory Self Test Artist',
      songIndex: 1,
    };
    const details: Record<string, unknown> = {
      storage: 'songloft.storage',
      storageKey: MEMORY_STORAGE_KEY,
      testData: {
        query,
        songId: testMemory.songId,
        songName: testMemory.songName,
        artist: testMemory.artist,
        songIndex: testMemory.songIndex,
      },
      steps: {},
    };
    const steps = details.steps as Record<string, StepResult>;

    let originalSnapshot: MemoryStoreSnapshot | null = null;

    try {
      logStep('start', 'info', '开始运行智能记忆存储自测');

      const restoreOriginalSnapshot = async (): Promise<void> => {
        if (!originalSnapshot) {
          steps.restore = { ok: false, message: '没有可恢复的原始快照' };
          return;
        }

        try {
          await adapter.save(originalSnapshot);
          steps.restore = { ok: true, message: '已恢复自测前的原始记忆快照' };
        } catch (error) {
          const errorDetails = adapter.getLastError() ?? toErrorDetails(error);
          steps.restore = { ok: false, message: '恢复原始记忆快照失败', error: errorDetails };
          logStep('restore', 'failed', errorDetails.message);
        }
      };

      try {
        const originalLoad = await adapter.load();
        originalSnapshot = originalLoad.snapshot ?? null;
        if (!originalSnapshot) {
          throw new Error(originalLoad.error || `storage load failed: ${originalLoad.status}`);
        }
        steps['load-original'] = { ok: true, message: '已读取原始记忆快照' };
      } catch (error) {
        const errorDetails = adapter.getLastError() ?? toErrorDetails(error);
        steps['load-original'] = { ok: false, message: '读取原始记忆快照失败', error: errorDetails };
        logStep('read', 'failed', errorDetails.message);
        logStep('done', 'failed', '自测失败');
        return makeResponse(false, 'load-original', '读取 songloft.storage 失败，无法继续自测', details);
      }

      await service.init();
      if (!service.isInitialized()) {
        const errorDetails = adapter.getLastError();
        steps.init = {
          ok: false,
          message: 'MemoryService 初始化失败',
          ...(errorDetails ? { error: errorDetails } : {}),
        };
        logStep('init', 'failed', errorDetails?.message ?? 'MemoryService 未初始化');
        logStep('done', 'failed', '自测失败');
        return makeResponse(false, 'init', 'MemoryService 初始化失败', details);
      }
      steps.init = { ok: true, message: 'MemoryService 初始化成功' };
      logStep('init', 'success', 'MemoryService 初始化成功');

      adapter.clearLastError();
      const normalizedQuery = service.normalizeQuery(query);
      details.normalizedQuery = normalizedQuery;
      const recordSuccessResult = await service.recordSuccess(testMemory);
      if (!recordSuccessResult) {
        const errorDetails = adapter.getLastError();
        steps.recordSuccess = {
          ok: false,
          message: 'recordSuccess 返回失败',
          ...(errorDetails ? { error: errorDetails } : {}),
        };
        steps.write = {
          ok: false,
          message: '写入测试记忆失败',
          ...(errorDetails ? { error: errorDetails } : {}),
        };
        logStep('recordSuccess', 'failed', errorDetails?.message ?? 'recordSuccess 返回 false');
        logStep('write', 'failed', errorDetails?.message ?? '写入测试记忆失败');
        await restoreOriginalSnapshot();
        logStep('done', 'failed', '自测失败');
        return makeResponse(false, 'recordSuccess', '写入测试记忆失败', details);
      }
      steps.recordSuccess = { ok: true, message: 'recordSuccess 调用成功' };
      steps.write = { ok: true, message: '测试记忆写入成功' };
      logStep('recordSuccess', 'success', 'recordSuccess 调用成功');
      logStep('write', 'success', '测试记忆写入成功');

      const readService = new MemoryService(adapter);
      adapter.clearLastError();
      await readService.init();
      const foundAfterWrite = readService.findByQuery(query);
      if (!readService.isInitialized() || !foundAfterWrite) {
        const errorDetails = adapter.getLastError();
        steps.read = {
          ok: false,
          message: !readService.isInitialized() ? '读取服务初始化失败' : '未读取到刚写入的测试记忆',
          ...(errorDetails ? { error: errorDetails } : {}),
        };
        logStep('read', 'failed', errorDetails?.message ?? '未读取到刚写入的测试记忆');
        await restoreOriginalSnapshot();
        logStep('done', 'failed', '自测失败');
        return makeResponse(false, 'read', '读取测试记忆失败', details);
      }
      steps.read = {
        ok: true,
        message: '读取测试记忆成功',
      };
      details.foundAfterWrite = {
        id: foundAfterWrite.id,
        type: foundAfterWrite.type,
        songId: foundAfterWrite.songId,
        songName: foundAfterWrite.songName,
        artist: foundAfterWrite.artist,
        hitCount: foundAfterWrite.hitCount,
        successCount: foundAfterWrite.successCount,
        failureCount: foundAfterWrite.failureCount,
      };
      logStep('read', 'success', '读取测试记忆成功');

      adapter.clearLastError();
      const failureResult = await readService.recordFailure(query);
      if (!failureResult) {
        const errorDetails = adapter.getLastError();
        steps.recordFailure = {
          ok: false,
          message: 'recordFailure 返回失败',
          ...(errorDetails ? { error: errorDetails } : {}),
        };
        logStep('recordFailure', 'failed', errorDetails?.message ?? 'recordFailure 返回 false');
        await restoreOriginalSnapshot();
        logStep('done', 'failed', '自测失败');
        return makeResponse(false, 'recordFailure', '更新失败计数失败', details);
      }

      const verifyService = new MemoryService(adapter);
      adapter.clearLastError();
      await verifyService.init();
      const foundAfterFailure = verifyService.findByQuery(query);
      steps.recordFailure = { ok: true, message: 'recordFailure 调用成功' };
      details.foundAfterFailure = foundAfterFailure ? {
        id: foundAfterFailure.id,
        hitCount: foundAfterFailure.hitCount,
        successCount: foundAfterFailure.successCount,
        failureCount: foundAfterFailure.failureCount,
      } : null;
      logStep('recordFailure', 'success', 'recordFailure 调用成功');

      const v2Result = await runMemoryV2SelfTest();
      details.v2 = v2Result;
      if (!v2Result.ok) {
        await restoreOriginalSnapshot();
        logStep('done', 'failed', 'V2 实体匹配自测失败');
        return makeResponse(false, 'done', 'V2 实体匹配自测失败', details);
      }

      await restoreOriginalSnapshot();
      if (!steps.restore.ok) {
        logStep('done', 'failed', '自测完成，但恢复原始快照失败');
        return makeResponse(false, 'restore', '自测完成，但恢复原始记忆快照失败', details);
      }

      logStep('done', 'success', '智能记忆存储自测通过');
      return makeResponse(true, 'done', '智能记忆存储自测通过', details);
    } catch (error) {
      const errorDetails = adapter.getLastError() ?? toErrorDetails(error);
      steps.unexpected = {
        ok: false,
        message: '自测发生未预期异常',
        error: errorDetails,
      };
      logStep('done', 'failed', errorDetails.message);

      if (originalSnapshot) {
        try {
          await adapter.save(originalSnapshot);
          steps.restore = { ok: true, message: '异常后已恢复原始记忆快照' };
        } catch (restoreError) {
          const restoreDetails = adapter.getLastError() ?? toErrorDetails(restoreError);
          steps.restore = { ok: false, message: '异常后恢复原始记忆快照失败', error: restoreDetails };
          logStep('restore', 'failed', restoreDetails.message);
        }
      }

      return makeResponse(false, 'done', '智能记忆存储自测失败', details);
    }
  });
}
