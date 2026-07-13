// MIoT 智能音箱插件 - 智能记忆调试 Handler

import { jsonResponse } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import { MemoryService, SongloftStorageMemoryAdapter } from '../memory';
import type { MemoryStoreSnapshot } from '../memory';

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name + ': ' + error.message;
  }
  return typeof error;
}

/**
 * 注册智能记忆调试路由
 * GET /memory/self-test → 验证 songloft.storage 读写智能记忆数据
 */
export function registerMemoryHandlers(router: Router): void {
  router.get('/memory/self-test', async (req: HTTPRequest) => {
    const adapter = new SongloftStorageMemoryAdapter();
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

    let originalSnapshot: MemoryStoreSnapshot | null = null;
    let restoreResult = false;

    try {
      originalSnapshot = await adapter.load();

      await service.init();
      const normalizedQuery = service.normalizeQuery(query);
      const writeResult = await service.recordSuccess(testMemory);
      const readService = new MemoryService(adapter);
      await readService.init();
      const foundAfterWrite = readService.findByQuery(query);
      const failureResult = await readService.recordFailure(query);
      const verifyService = new MemoryService(adapter);
      await verifyService.init();
      const foundAfterFailure = verifyService.findByQuery(query);

      try {
        restoreResult = await adapter.save(originalSnapshot);
      } catch (restoreError) {
        songloft.log.warn('[MemorySelfTest] restore failed: ' + describeError(restoreError));
      }

      const passed = writeResult && !!foundAfterWrite && failureResult && !!foundAfterFailure;
      return jsonResponse({
        success: passed,
        data: {
          storage: 'songloft.storage',
          initialized: service.isInitialized(),
          readInitialized: readService.isInitialized(),
          verifyInitialized: verifyService.isInitialized(),
          normalizedQuery,
          write: {
            success: writeResult,
            found: !!foundAfterWrite,
            record: foundAfterWrite ? {
              id: foundAfterWrite.id,
              type: foundAfterWrite.type,
              songId: foundAfterWrite.songId,
              songName: foundAfterWrite.songName,
              artist: foundAfterWrite.artist,
              hitCount: foundAfterWrite.hitCount,
              successCount: foundAfterWrite.successCount,
              failureCount: foundAfterWrite.failureCount,
            } : null,
          },
          recordSuccess: {
            success: writeResult,
          },
          recordFailure: {
            success: failureResult,
            found: !!foundAfterFailure,
            record: foundAfterFailure ? {
              id: foundAfterFailure.id,
              hitCount: foundAfterFailure.hitCount,
              successCount: foundAfterFailure.successCount,
              failureCount: foundAfterFailure.failureCount,
            } : null,
          },
          restore: {
            attempted: true,
            success: restoreResult,
          },
        },
      }, passed ? 200 : 500);
    } catch (error) {
      songloft.log.warn('[MemorySelfTest] failed: ' + describeError(error));

      if (originalSnapshot) {
        try {
          restoreResult = await adapter.save(originalSnapshot);
        } catch (restoreError) {
          songloft.log.warn('[MemorySelfTest] restore after failure failed: ' + describeError(restoreError));
        }
      }

      return jsonResponse({
        success: false,
        error: describeError(error),
        data: {
          storage: 'songloft.storage',
          restore: {
            attempted: !!originalSnapshot,
            success: restoreResult,
          },
        },
      }, 500);
    }
  });
}
