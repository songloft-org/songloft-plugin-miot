import type { MemoryRecord } from './types';
import { compactPinyin, isChineseName, normalizeEntityText, readableKeyPart } from './query_normalizer';

const MAX_ALIASES_PER_ENTITY = 6;
const MAX_FUZZY_CANDIDATES = 20;

export interface DerivedMemoryRecord {
  record: MemoryRecord;
  canonicalKey: string;
  normalizedTitle: string;
  normalizedArtist: string;
  titlePinyin: string;
  artistPinyin: string;
  aliases: string[];
  successRatio: number;
  playable: boolean;
}

export interface MemoryEntity {
  canonicalKey: string;
  recordIds: Set<string>;
  representative: MemoryRecord;
  normalizedTitle: string;
  normalizedArtist: string;
  titlePinyin: string;
  artistPinyin: string;
  shortArtist?: string;
  aliases: string[];
}

function addIndex(index: Map<string, Set<string>>, key: string, canonicalKey: string): void {
  if (!key) return;
  const values = index.get(key) ?? new Set<string>();
  values.add(canonicalKey);
  index.set(key, values);
}

function playbackRank(record: MemoryRecord): number {
  if (typeof record.playlistId === 'number' && typeof record.songIndex === 'number') return 3;
  if (typeof record.songId === 'number') return 2;
  if (record.songName) return 1;
  return 0;
}

function failureRate(record: MemoryRecord): number {
  const total = record.successCount + record.failureCount;
  return total > 0 ? record.failureCount / total : 1;
}

function compareRepresentative(a: MemoryRecord, b: MemoryRecord): number {
  const playback = playbackRank(b) - playbackRank(a);
  if (playback !== 0) return playback;
  const success = b.successCount - a.successCount;
  if (success !== 0) return success;
  const failure = failureRate(a) - failureRate(b);
  if (failure !== 0) return failure;
  const lastUsed = b.lastUsedAt.localeCompare(a.lastUsedAt);
  if (lastUsed !== 0) return lastUsed;
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function canonicalKeyForRecord(record: Pick<MemoryRecord, 'songId' | 'songName' | 'artist' | 'canonicalKey'>): string {
  if (typeof record.songId === 'number' && Number.isFinite(record.songId)) {
    return `song:id:${record.songId}`;
  }
  if (record.canonicalKey?.startsWith('song:external:')) {
    return record.canonicalKey;
  }
  const title = normalizeEntityText(record.songName || '');
  const artist = normalizeEntityText(record.artist || '');
  if (!title) return '';
  // Album is not present in V1 records, so the third metadata component is intentionally empty.
  return `song:meta:${readableKeyPart(title)}|${readableKeyPart(artist)}|`;
}

export class MemoryEntityIndex {
  readonly exactQueryIndex = new Map<string, MemoryRecord>();
  readonly recordById = new Map<string, MemoryRecord>();
  readonly canonicalIndex = new Map<string, Set<string>>();
  readonly titleIndex = new Map<string, Set<string>>();
  readonly artistTitleIndex = new Map<string, Set<string>>();
  readonly aliasIndex = new Map<string, Set<string>>();
  readonly pinyinIndex = new Map<string, Set<string>>();
  readonly derivedByRecordId = new Map<string, DerivedMemoryRecord>();
  readonly entities = new Map<string, MemoryEntity>();
  private titleLengthIndex = new Map<string, Set<string>>();

  rebuild(records: Iterable<MemoryRecord>): void {
    this.clear();
    const playableRecords = Array.from(records).filter(record => {
      this.exactQueryIndex.set(record.normalizedQuery, record);
      this.recordById.set(record.id, record);
      return record.type === 'play_song' && !!record.songName;
    });

    const metadataIdKeys = new Map<string, Set<string>>();
    for (const record of playableRecords) {
      if (typeof record.songId !== 'number') continue;
      const title = normalizeEntityText(record.songName || '');
      const artist = normalizeEntityText(record.artist || '');
      const metadataKey = `${title}\u0000${artist}`;
      addIndex(metadataIdKeys, metadataKey, `song:id:${record.songId}`);
    }

    const prelim = playableRecords.map(record => {
      const normalizedTitle = normalizeEntityText(record.songName || '');
      const normalizedArtist = normalizeEntityText(record.artist || '');
      let canonicalKey = canonicalKeyForRecord(record);
      if (typeof record.songId !== 'number') {
        const idKeys = metadataIdKeys.get(`${normalizedTitle}\u0000${normalizedArtist}`);
        if (idKeys?.size === 1) canonicalKey = Array.from(idKeys)[0];
      }
      return { record, normalizedTitle, normalizedArtist, canonicalKey };
    }).filter(item => !!item.canonicalKey && !!item.normalizedTitle);

    const shortArtists = new Map<string, Set<string>>();
    for (const item of prelim) {
      if (!isChineseName(item.normalizedArtist)) continue;
      const shortName = Array.from(item.normalizedArtist).slice(-2).join('');
      const artists = shortArtists.get(shortName) ?? new Set<string>();
      artists.add(item.normalizedArtist);
      shortArtists.set(shortName, artists);
    }

    const grouped = new Map<string, typeof prelim>();
    for (const item of prelim) {
      const items = grouped.get(item.canonicalKey) ?? [];
      items.push(item);
      grouped.set(item.canonicalKey, items);
    }

    for (const [canonicalKey, items] of grouped) {
      const sorted = items.slice().sort((a, b) => compareRepresentative(a.record, b.record));
      const primary = sorted[0];
      const metadataSource = sorted.find(item => item.normalizedArtist) ?? primary;
      const recordIds = new Set(items.map(item => item.record.id));
      const normalizedArtist = metadataSource.normalizedArtist;
      const shortName = isChineseName(normalizedArtist)
        ? Array.from(normalizedArtist).slice(-2).join('')
        : '';
      const shortArtist = shortName && shortArtists.get(shortName)?.size === 1 ? shortName : undefined;
      const aliases = [
        primary.normalizedTitle,
        normalizedArtist + primary.normalizedTitle,
        normalizedArtist ? `${normalizedArtist}的${primary.normalizedTitle}` : '',
        shortArtist ? shortArtist + primary.normalizedTitle : '',
        shortArtist ? `${shortArtist}的${primary.normalizedTitle}` : '',
      ].filter((value, index, all) => !!value && all.indexOf(value) === index)
        .slice(0, MAX_ALIASES_PER_ENTITY);

      const entity: MemoryEntity = {
        canonicalKey,
        recordIds,
        representative: primary.record,
        normalizedTitle: primary.normalizedTitle,
        normalizedArtist,
        titlePinyin: compactPinyin(primary.normalizedTitle),
        artistPinyin: compactPinyin(normalizedArtist),
        shortArtist,
        aliases,
      };
      this.entities.set(canonicalKey, entity);
      this.canonicalIndex.set(canonicalKey, recordIds);
      addIndex(this.titleIndex, entity.normalizedTitle, canonicalKey);
      addIndex(this.artistTitleIndex, `${entity.normalizedArtist}\u0000${entity.normalizedTitle}`, canonicalKey);
      addIndex(this.titleLengthIndex, String(Array.from(entity.normalizedTitle).length), canonicalKey);

      for (const alias of aliases) {
        addIndex(this.aliasIndex, alias, canonicalKey);
        addIndex(this.pinyinIndex, compactPinyin(alias), canonicalKey);
      }

      for (const item of items) {
        const successTotal = item.record.successCount + item.record.failureCount;
        this.derivedByRecordId.set(item.record.id, {
          record: item.record,
          canonicalKey,
          normalizedTitle: item.normalizedTitle,
          normalizedArtist: item.normalizedArtist,
          titlePinyin: compactPinyin(item.normalizedTitle),
          artistPinyin: compactPinyin(item.normalizedArtist),
          aliases,
          successRatio: successTotal > 0 ? item.record.successCount / successTotal : 0,
          playable: playbackRank(item.record) > 0,
        });
      }
    }
  }

  getFuzzyCandidates(titleLength: number): string[] {
    const result: string[] = [];
    for (let length = Math.max(2, titleLength - 1); length <= titleLength + 1; length++) {
      for (const key of this.titleLengthIndex.get(String(length)) ?? []) {
        if (!result.includes(key)) result.push(key);
        if (result.length >= MAX_FUZZY_CANDIDATES) return result;
      }
    }
    return result;
  }

  clear(): void {
    this.exactQueryIndex.clear();
    this.recordById.clear();
    this.canonicalIndex.clear();
    this.titleIndex.clear();
    this.artistTitleIndex.clear();
    this.aliasIndex.clear();
    this.pinyinIndex.clear();
    this.derivedByRecordId.clear();
    this.entities.clear();
    this.titleLengthIndex.clear();
  }
}
