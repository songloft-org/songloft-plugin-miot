import type { MemoryResolveResult } from './types';
import type { MemoryEntity } from './entity_index';
import { MemoryEntityIndex } from './entity_index';
import { normalizeMemoryQuery } from './query_normalizer';

const DIRECT_SCORE_THRESHOLD = 0.92;
const DIRECT_MARGIN_THRESHOLD = 0.08;

interface ScoredCandidate {
  entity: MemoryEntity;
  score: number;
  exactTitle: boolean;
  fullArtist: boolean;
  shortArtist: boolean;
  reason: string;
}

function levenshtein(a: string, b: string): number {
  const aa = Array.from(a);
  const bb = Array.from(b);
  let previous = Array.from({ length: bb.length + 1 }, (_, i) => i);
  let current = new Array<number>(bb.length + 1);
  for (let i = 1; i <= aa.length; i++) {
    current[0] = i;
    for (let j = 1; j <= bb.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (aa[i - 1] === bb[j - 1] ? 0 : 1),
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[bb.length];
}

function similarity(a: string, b: string): number {
  const maxLength = Math.max(Array.from(a).length, Array.from(b).length);
  return maxLength === 0 ? 1 : 1 - levenshtein(a, b) / maxLength;
}

function historyBonus(entity: MemoryEntity): number {
  if (entity.representative.successCount >= 3) return 0.02;
  if (entity.representative.successCount >= 1) return 0.01;
  return 0;
}

function failureRate(entity: MemoryEntity): number {
  const record = entity.representative;
  const total = record.successCount + record.failureCount;
  return total > 0 ? record.failureCount / total : 1;
}

export class MemoryResolver {
  constructor(private readonly index: MemoryEntityIndex) {}

  resolve(query: string): MemoryResolveResult {
    const normalized = normalizeMemoryQuery(query);
    const semantic = normalized.semanticText;
    if (!semantic) return { status: 'miss', reason: 'empty_semantic_text', candidateCount: 0 };

    const candidateKeys = new Set<string>();
    for (const key of this.index.aliasIndex.get(semantic) ?? []) candidateKeys.add(key);
    for (const key of this.index.titleIndex.get(semantic) ?? []) candidateKeys.add(key);
    for (const key of this.index.pinyinIndex.get(normalized.pinyin) ?? []) candidateKeys.add(key);
    for (const key of this.index.getFuzzyCandidates(Array.from(semantic).length)) candidateKeys.add(key);

    const scored: ScoredCandidate[] = [];
    for (const canonicalKey of candidateKeys) {
      const entity = this.index.entities.get(canonicalKey);
      if (!entity) continue;

      const exactTitle = semantic === entity.normalizedTitle;
      const fullArtist = !!entity.normalizedArtist && (
        semantic === entity.normalizedArtist + entity.normalizedTitle ||
        semantic === `${entity.normalizedArtist}的${entity.normalizedTitle}`
      );
      const shortArtist = !!entity.shortArtist && (
        semantic === entity.shortArtist + entity.normalizedTitle ||
        semantic === `${entity.shortArtist}的${entity.normalizedTitle}`
      );
      const pinyinTitle = !exactTitle && normalized.pinyin === entity.titlePinyin;
      let score = exactTitle || fullArtist || shortArtist ? 0.78 : 0;
      let reason = exactTitle ? 'exact_title' : fullArtist ? 'full_artist_title' : shortArtist ? 'unique_short_artist_title' : '';

      if (fullArtist) score += 0.18;
      if (shortArtist) score += 0.12;
      const titleEntities = this.index.titleIndex.get(entity.normalizedTitle)?.size ?? 0;
      if (exactTitle && !fullArtist && !shortArtist && titleEntities === 1) {
        score += 0.18;
        reason = 'unique_exact_title';
      }
      if (!exactTitle && !fullArtist && !shortArtist && pinyinTitle) {
        score = 0.68;
        reason = 'pinyin_title_only';
      }
      if (score === 0 && Array.from(entity.normalizedTitle).length > 1) {
        const sim = similarity(semantic, entity.normalizedTitle);
        if (sim >= 0.7) {
          score = Math.min(0.65, sim * 0.65);
          reason = 'edit_distance_title_only';
        }
      }
      if (normalized.wrapperStripped && score > 0) score += 0.02;
      if (score > 0) score += historyBonus(entity);
      if (score > 0) {
        scored.push({ entity, score: Math.min(1, score), exactTitle: exactTitle || fullArtist || shortArtist, fullArtist, shortArtist, reason });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.entity.canonicalKey.localeCompare(b.entity.canonicalKey));
    if (scored.length === 0 || scored[0].score <= 0) {
      return { status: 'miss', reason: 'no_candidate', candidateCount: 0 };
    }

    const best = scored[0];
    const secondScore = scored[1]?.score ?? 0;
    const margin = best.score - secondScore;
    const titleEntityCount = this.index.titleIndex.get(best.entity.normalizedTitle)?.size ?? 0;
    const duplicateTitleWithoutArtist = titleEntityCount > 1 && !best.fullArtist && !best.shortArtist;
    if (duplicateTitleWithoutArtist || (scored.length > 1 && margin < DIRECT_MARGIN_THRESHOLD)) {
      return {
        status: 'ambiguous',
        canonicalKey: best.entity.canonicalKey,
        score: best.score,
        reason: duplicateTitleWithoutArtist ? 'duplicate_title' : 'candidate_margin_too_small',
        candidateCount: scored.length,
        margin,
      };
    }

    const record = best.entity.representative;
    const titleLength = Array.from(best.entity.normalizedTitle).length;
    const hasArtistOrUniqueTitle = best.fullArtist || best.shortArtist || titleEntityCount === 1;
    const playable = record.type === 'play_song' && !!record.songName && (
      typeof record.songId === 'number' ||
      (typeof record.playlistId === 'number' && typeof record.songIndex === 'number') ||
      !!record.songName
    );
    const safe = best.score >= DIRECT_SCORE_THRESHOLD &&
      margin >= DIRECT_MARGIN_THRESHOLD &&
      best.exactTitle &&
      hasArtistOrUniqueTitle &&
      titleLength > 1 &&
      record.successCount >= 1 &&
      failureRate(best.entity) < 0.5 &&
      playable;

    if (!safe) {
      return {
        status: 'miss',
        canonicalKey: best.entity.canonicalKey,
        score: best.score,
        reason: titleLength <= 1 ? 'single_character_title' : best.reason || 'below_safety_gate',
        candidateCount: scored.length,
        margin,
      };
    }

    return {
      status: 'entity_hit',
      record,
      canonicalKey: best.entity.canonicalKey,
      score: best.score,
      reason: best.reason,
      candidateCount: scored.length,
      margin,
    };
  }
}
