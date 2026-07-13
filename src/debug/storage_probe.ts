// MIoT 智能音箱插件 - persistentStorage 探针
// 安全约束：不保存账号、token、cookie 或任何用户数据。

/// <reference types="@songloft/plugin-sdk" />

const PROBE_LOG_PREFIX = '[persistent-storage-probe]';
const PROBE_KEY = 'smart-memory-probe-test';

function getErrorType(error: unknown): string {
  if (!error) return 'unknown';
  if (error instanceof Error) return error.name || error.constructor?.name || 'Error';
  const ctorName = (error as any)?.constructor?.name;
  return ctorName || typeof error;
}

function getErrorMessage(error: unknown): string {
  if (!error) return '';
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function logResult(step: string, ok: boolean, details = ''): void {
  const result = ok ? 'success' : 'failed';
  const suffix = details ? ` ${details}` : '';
  songloft.log.info(`${PROBE_LOG_PREFIX} ${step} result=${result}${suffix}`);
}

function logError(step: string, error: unknown): void {
  songloft.log.warn(
    `${PROBE_LOG_PREFIX} ${step} result=failed error_type=${getErrorType(error)} error=${getErrorMessage(error)}`
  );
}

export async function runPersistentStorageProbe(): Promise<void> {
  const persistentStorage = (songloft as any).persistentStorage;
  if (!persistentStorage) {
    songloft.log.warn(`${PROBE_LOG_PREFIX} unavailable error_type=Unavailable`);
    return;
  }

  songloft.log.info(`${PROBE_LOG_PREFIX} available`);

  const testValue = {
    test: true,
    timestamp: Date.now(),
  };

  try {
    await persistentStorage.set(PROBE_KEY, testValue);
    logResult('set', true);
  } catch (error) {
    logError('set', error);
    return;
  }

  try {
    const value = await persistentStorage.get(PROBE_KEY);
    const valueType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    logResult('get', true, `value_type=${valueType}`);
  } catch (error) {
    logError('get', error);
    return;
  }

  try {
    const keys = await persistentStorage.keys();
    const keyCount = Array.isArray(keys) ? keys.length : -1;
    const hasProbeKey = Array.isArray(keys) && keys.includes(PROBE_KEY);
    logResult('keys', true, `key_count=${keyCount} has_probe_key=${hasProbeKey}`);
  } catch (error) {
    logError('keys', error);
    return;
  }

  try {
    await persistentStorage.delete(PROBE_KEY);
    logResult('delete', true);
  } catch (error) {
    logError('delete', error);
  }
}
