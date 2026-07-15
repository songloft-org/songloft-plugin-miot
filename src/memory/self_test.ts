import { MemoryEntityIndex } from './entity_index';
import { MemoryResolver } from './memory_resolver';
import { MemoryService } from './memory_service';
import { normalizeMemoryQuery } from './query_normalizer';
import type { MemoryLoadResult, MemoryRecord, MemoryStorageAdapter, MemoryStoreSnapshot } from './types';
import { normalizeMemoryMaxRecords } from './types';

export interface MemoryV2SelfTestCheck {
  name: string;
  ok: boolean;
  message?: string;
}

export interface MemoryV2SelfTestResult {
  ok: boolean;
  checks: MemoryV2SelfTestCheck[];
  performance: Record<string, number>;
  runtimeChecks: string[];
}

function timestamp(offset = 0): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}

function record(
  id: string,
  query: string,
  songName?: string,
  artist?: string,
  songId?: number,
): MemoryRecord {
  return {
    id,
    query,
    normalizedQuery: query.toLowerCase().replace(/\s+/g, ''),
    type: 'play_song',
    songId,
    songName,
    artist,
    playlistId: songName ? 1 : undefined,
    playlistName: songName ? 'self-test' : undefined,
    songIndex: songName ? 0 : undefined,
    hitCount: 1,
    successCount: 1,
    failureCount: 0,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    lastUsedAt: timestamp(),
  };
}

function snapshot(records: MemoryRecord[]): MemoryStoreSnapshot {
  return { version: 1, records, updatedAt: timestamp() };
}

class InMemoryAdapter implements MemoryStorageAdapter {
  current: MemoryStoreSnapshot;
  loadStatus: MemoryLoadResult['status'] = 'ok';
  failSave = false;
  throwSaveOnce = false;
  saveCount = 0;

  constructor(records: MemoryRecord[] = []) {
    this.current = snapshot(records);
  }

  async load(): Promise<MemoryLoadResult> {
    if (this.loadStatus === 'read_error' || this.loadStatus === 'format_error') {
      return { status: this.loadStatus, error: 'self-test load failure' };
    }
    return { status: this.loadStatus, snapshot: JSON.parse(JSON.stringify(this.current)) as MemoryStoreSnapshot };
  }

  async save(value: MemoryStoreSnapshot): Promise<boolean> {
    this.saveCount++;
    if (this.throwSaveOnce) {
      this.throwSaveOnce = false;
      throw new Error('self-test rejected save');
    }
    if (this.failSave) return false;
    this.current = JSON.parse(JSON.stringify(value)) as MemoryStoreSnapshot;
    return true;
  }
}

function resolve(records: MemoryRecord[], query: string) {
  const index = new MemoryEntityIndex();
  index.rebuild(records);
  return { result: new MemoryResolver(index).resolve(query), index };
}

export async function runMemoryV2SelfTest(): Promise<MemoryV2SelfTestResult> {
  const checks: MemoryV2SelfTestCheck[] = [];
  const performance: Record<string, number> = {};
  const check = (name: string, ok: boolean, message = ''): void => {
    checks.push({ name, ok, ...(message ? { message } : {}) });
  };

  const sunny = record('sunny-1', '来首周杰伦的晴天', '晴天', '周杰伦', 101);
  const v1Adapter = new InMemoryAdapter([sunny]);
  const v1Service = new MemoryService(v1Adapter);
  await v1Service.init();
  check('v1_exact_unchanged', v1Service.findByQuery('来首周杰伦的晴天')?.id === sunny.id);
  check('unique_title_hit', v1Service.resolveEntity('放晴天').status === 'entity_hit');
  check('unique_short_artist_hit', v1Service.resolveEntity('来首杰伦的晴天').status === 'entity_hit');
  check('full_artist_title_hit', v1Service.resolveEntity('我想听周杰伦晴天').status === 'entity_hit');

  const sameSongRecords = [
    sunny,
    record('sunny-2', '放晴天', '晴天', '周杰伦', 101),
    record('sunny-3', '我想听周杰伦晴天', '晴天', '周杰伦', 101),
  ];
  check('same_song_queries_one_entity', resolve(sameSongRecords, '放晴天').index.entities.size === 1);

  const v3Adapter = new InMemoryAdapter([sunny]);
  const v3Service = new MemoryService(v3Adapter);
  await v3Service.init();
  const addedAlias = await v3Service.addManualAlias('song:id:101', '再听一遍晴天');
  check('v3_manual_alias_saved', addedAlias.ok && v3Service.findByQuery('再听一遍晴天')?.manualAlias === true);
  check('v3_entity_aggregation', v3Service.listEntities().length === 1 && v3Service.listEntities()[0].queryCount === 2);
  v3Service.queueHit(sunny.id, 'self_test_exact');
  check('v3_pending_hit_visible', v3Service.getStats().localHitCount >= 1);
  await v3Service.flushPendingHits();
  check('v3_debounced_hit_saved', (v3Service.findById(sunny.id)?.memoryHitCount ?? 0) === 1);
  const blockedAlias = await v3Service.addManualAlias('song:id:101', '暂停播放');
  check('v3_fixed_control_alias_blocked', !blockedAlias.ok);
  if (addedAlias.record) await v3Service.deleteEntityAlias('song:id:101', addedAlias.record.id);
  check('v3_alias_delete_rebuilds_index', v3Service.findByQuery('再听一遍晴天') === null);
  await v3Service.deleteEntity('song:id:101');
  check('v3_entity_delete_rebuilds_index', v3Service.count() === 0 && v3Service.getIndexStats().entities === 0);
  check('v3_max_records_clamped', normalizeMemoryMaxRecords(1000) === 500);

  const duplicated = [
    record('later-1', '播放刘若英后来', '后来', '刘若英', 201),
    record('later-2', '播放其他歌手后来', '后来', '其他歌手', 202),
  ];
  const ambiguousResult = resolve(duplicated, '播放后来').result;
  check('duplicate_title_ambiguous', ambiguousResult.status === 'ambiguous');
  check('v3_ambiguity_candidates_bounded', (ambiguousResult.candidates?.length ?? 0) === 2);
  check('duplicate_title_full_artist_hit', resolve(duplicated, '播放刘若英的后来').result.status === 'entity_hit');

  const shortCollision = [
    record('short-1', '播放张杰伦甲歌', '甲歌', '张杰伦', 301),
    record('short-2', '播放周杰伦乙歌', '乙歌', '周杰伦', 302),
  ];
  check('shared_short_artist_disabled', resolve(shortCollision, '播放杰伦的乙歌').result.status !== 'entity_hit');
  check('single_character_title_blocked', resolve([record('one', '播放光', '光', '陈粒', 401)], '播放光').result.status !== 'entity_hit');
  check('homophone_only_blocked', resolve([sunny], '播放青天').result.status !== 'entity_hit');

  const preservedDe = normalizeMemoryQuery('播放你不知道的事').semanticText;
  const preservedMusic = normalizeMemoryQuery('播放音乐之声').semanticText;
  check('title_with_de_preserved', preservedDe === '你不知道的事');
  check('title_with_music_preserved', preservedMusic === '音乐之声');
  check('fixed_control_not_memory_candidate', resolve([sunny], '暂停播放').result.status !== 'entity_hit');

  const legacy = record('legacy', '旧口令', undefined, undefined, undefined);
  const legacyService = new MemoryService(new InMemoryAdapter([legacy]));
  await legacyService.init();
  check('legacy_v1_loads', legacyService.findByQuery('旧口令')?.id === legacy.id);
  check('legacy_without_song_not_v2', legacyService.resolveEntity('旧口令').status !== 'entity_hit');
  check('v3_legacy_visible_as_unclassified', legacyService.listUnclassified().length === 1 && legacyService.getStats().recordCount === 1);
  await legacyService.deleteById(legacy.id);
  check('v3_unclassified_delete_keeps_indexes_consistent', legacyService.listUnclassified().length === 0 && legacyService.count() === 0);

  const deleteService = new MemoryService(new InMemoryAdapter([sunny]));
  await deleteService.init();
  await deleteService.deleteById(sunny.id);
  check('delete_removes_alias', deleteService.resolveEntity('放晴天').status !== 'entity_hit');

  const clearService = new MemoryService(new InMemoryAdapter([sunny]));
  await clearService.init();
  await clearService.clear();
  check('clear_removes_indexes', clearService.getIndexStats().entities === 0 && clearService.getIndexStats().aliases === 0);

  const evictionRecords = Array.from({ length: 11 }, (_, i) => record(`evict-${i}`, `播放测试歌${i}`, `测试歌${i}`, '测试歌手', 500 + i));
  const evictionService = new MemoryService(new InMemoryAdapter(evictionRecords), 10);
  await evictionService.init();
  check('eviction_rebuilds_indexes', evictionService.count() === 10 && evictionService.getIndexStats().records === 10);

  const failedAdapter = new InMemoryAdapter([sunny]);
  const failedService = new MemoryService(failedAdapter);
  await failedService.init();
  const beforeFailure = JSON.stringify(failedService.list());
  failedAdapter.failSave = true;
  await failedService.recordSuccess({ query: '新的晴天口令', type: 'play_song', songName: '晴天', artist: '周杰伦', songId: 101 });
  check('save_failure_keeps_state', JSON.stringify(failedService.list()) === beforeFailure && failedService.resolveEntity('新的晴天口令').status !== 'entity_hit');

  const readFailedAdapter = new InMemoryAdapter([sunny]);
  readFailedAdapter.loadStatus = 'read_error';
  const readFailedService = new MemoryService(readFailedAdapter);
  await readFailedService.init();
  const writeAfterReadFailure = await readFailedService.recordSuccess({ query: '不应写入', type: 'play_song', songName: '晴天', artist: '周杰伦', songId: 101 });
  check('read_failure_never_overwrites', !readFailedService.isInitialized() && !writeAfterReadFailure && readFailedAdapter.saveCount === 0);

  const recoveringAdapter = new InMemoryAdapter();
  const recoveringService = new MemoryService(recoveringAdapter);
  await recoveringService.init();
  recoveringAdapter.throwSaveOnce = true;
  const rejectedWrite = await recoveringService.recordSuccess({ query: '失败写入', type: 'play_song', songName: '失败歌曲', artist: '测试歌手', songId: 601 });
  const recoveredWrite = await recoveringService.recordSuccess({ query: '恢复写入', type: 'play_song', songName: '恢复歌曲', artist: '测试歌手', songId: 602 });
  check('write_queue_recovers_after_rejection', !rejectedWrite && recoveredWrite && recoveringService.findByQuery('恢复写入') !== null);

  const formatFailedAdapter = new InMemoryAdapter([sunny]);
  formatFailedAdapter.loadStatus = 'format_error';
  const formatFailedService = new MemoryService(formatFailedAdapter);
  await formatFailedService.init();
  const formatWrite = await formatFailedService.recordSuccess({ query: '格式错误后写入', type: 'play_song', songName: '晴天', artist: '周杰伦', songId: 101 });
  check('format_failure_never_overwrites', !formatFailedService.isInitialized() && !formatWrite && formatFailedAdapter.saveCount === 0);

  const concurrentAdapter = new InMemoryAdapter();
  const concurrentService = new MemoryService(concurrentAdapter, 100);
  await concurrentService.init();
  await Promise.all(Array.from({ length: 20 }, (_, i) => concurrentService.recordSuccess({
    query: `并发口令${i}`,
    type: 'play_song',
    songName: `并发歌曲${i}`,
    artist: '并发歌手',
    songId: 700 + i,
  })));
  check('concurrent_writes_no_loss', concurrentService.count() === 20 && concurrentService.getIndexStats().records === 20);

  const deleteId = concurrentService.list()[0].id;
  await Promise.all([
    concurrentService.deleteById(deleteId),
    concurrentService.recordSuccess({ query: '并发新增', type: 'play_song', songName: '并发新增', artist: '并发歌手', songId: 999 }),
    concurrentService.setMaxRecords(10),
  ]);
  check('mixed_concurrency_consistent', concurrentService.count() <= 10 && concurrentService.getIndexStats().records === concurrentService.count());

  for (const size of [10, 100, 500]) {
    const records = Array.from({ length: size }, (_, i) => record(`perf-${size}-${i}`, `播放性能歌曲${i}`, `性能歌曲${i}`, '性能歌手', 10000 + i));
    const start = Date.now();
    const index = new MemoryEntityIndex();
    index.rebuild(records);
    new MemoryResolver(index).resolve(`播放性能歌曲${size - 1}`);
    performance[`records_${size}_ms`] = Date.now() - start;
  }
  check('bounded_performance', Object.values(performance).every(ms => ms < 2000), JSON.stringify(performance));

  const runtimeChecks = [
    'fixed control commands are executed before memory in VoiceEngine.handleMessage',
    'voice_memory_enabled=false skips lookup and writes',
    'memory playback failure falls through to rules and AI',
    'resolver or memory exceptions fall through to rules and AI',
  ];
  return { ok: checks.every(item => item.ok), checks, performance, runtimeChecks };
}
