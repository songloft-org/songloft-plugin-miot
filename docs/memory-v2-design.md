# Voice Memory V2.0 Design

## Scope

Voice Memory V2.0 adds conservative local entity matching on top of the existing V1 exact-query memory. It does not use a local model, embeddings, a vector database, an external service, runtime `segmentit`, or new npm dependencies.

The storage backend remains `songloft.storage`. The storage key remains `memory:v1:records`, and the snapshot envelope remains `version: 1`.

## Runtime Order

The real voice path is:

1. VoiceEngine enabled check and query extraction.
2. Built-in pause/stop aliases and configured fixed control commands.
3. Voice Memory configuration read inside a fallback boundary.
4. V1 `normalizedQuery` exact lookup.
5. V2 local entity resolution.
6. Existing song or playlist rule matching.
7. AI fallback only when no search rule matched.
8. Existing smart-resume behavior when nothing handled the query.

Any configuration, storage, normalization, index, resolver, or memory-playback failure returns to the existing rule and AI path. Fixed controls always run before V1 and V2 memory.

## V1 And V2

V1 keeps the existing `normalizeQuery()` and `findByQuery()` behavior. An exact V1 hit is attempted first and is not rescored by V2.

V2 runs only after a V1 miss. It strips explicit playback wrappers from the beginning or end of the query, then compares the semantic text with entities derived from successful memory records. It does not attempt general Chinese language parsing.

## Persisted Data

All V1 fields remain unchanged. V2 adds only two optional record fields:

```ts
recordVersion?: 2;
canonicalKey?: string;
```

Normalized title and artist, pinyin, aliases, success ratio, and playability are derived in memory and are not written to the snapshot.

## Canonical Keys

Canonical keys never contain a query, URL, playlist ID, song index, or timestamp.

The current priority is:

1. `song:id:<songId>` when a stable Songloft song ID exists.
2. An existing trusted `song:external:` key when a future provider identity is available in the record.
3. `song:meta:<escapedTitle>|<escapedArtist>|<escapedAlbum>` otherwise.

V1 has no album field, so its metadata key uses an empty third component. Key parts use deterministic built-in escaping; no crypto or hash dependency is added.

Records with the same exact title and artist metadata are associated with a single known song-ID entity when that metadata maps to exactly one song ID. Conflicting IDs remain separate entities and trigger ambiguity protection.

## Query Normalization

V2 performs lightweight full-width ASCII folding, lowercasing, whitespace removal, and decorative punctuation removal. The character `的` is retained.

Playback wrappers are matched longest-first and only at the start of the query. Examples include `帮我播放一下`, `帮我放一下`, `给我播放`, `我想听`, `我要听`, `来一首`, `播放`, `来首`, and `放`.

Only longer, explicit polite suffixes are removed. Short suffixes such as `一下`, `吧`, and `啊` are deliberately retained because they can be part of a real song title. `歌曲` and `音乐` are not globally removed, preserving titles such as `歌曲中的故事` and `音乐之声`.

## Entity Index

The in-memory index contains:

- `exactQueryIndex`: normalized query to record.
- `recordById`: record ID to record.
- `canonicalIndex`: canonical key to record-ID set.
- `titleIndex`: normalized title to canonical-key set.
- `artistTitleIndex`: normalized artist and title to canonical-key set.
- `aliasIndex`: conservative alias to canonical-key set.
- `pinyinIndex`: pinyin alias to canonical-key set, candidate generation only.
- `derivedByRecordId`: transient normalized and reliability data.

All uniqueness and candidate counts use canonical entities, not raw record counts. The index is rebuilt from the committed records after load and every successful mutation.

## Representative Selection

An entity can contain multiple learned queries. Its playback representative is selected deterministically by:

1. Complete playback location.
2. Higher `successCount`.
3. Lower failure rate.
4. Newer `lastUsedAt`.
5. Newer `updatedAt`.

The resolver never selects the first Map entry at random.

## Alias Policy

Each entity generates at most six aliases:

- Exact song title.
- Full artist plus title.
- Full artist plus `的` plus title.
- Unique conservative artist short name plus title.
- Unique conservative short name plus `的` plus title.

A Chinese artist short name is generated only for an all-Chinese name of at least three characters. It uses the final two characters and is enabled only when those characters identify one full artist across the current memory index. Two-character and English artist names do not get automatic short names. A short artist name never works without an exact song title.

## Candidate Generation And Safety Gate

Exact aliases and titles generate candidates first. Pinyin exact matches and bounded edit-distance checks can add candidates, but cannot directly play a song. Edit distance examines no more than 20 candidates selected from nearby title-length buckets.

Evidence scores are capped at 1.0:

- Exact title: `0.78`.
- Full artist: `+0.18`.
- Unique conservative artist short name: `+0.12`.
- Globally unique title when no artist is supplied: `+0.18`.
- Explicit wrapper removed: `+0.02`.
- Reliable successful history: up to `+0.02`.
- Pinyin title only: at most `0.68`.
- Edit-distance title only: at most `0.65`.

Direct playback requires score at least `0.92`, top-candidate margin at least `0.08`, one clear canonical entity, at least one prior success, failure rate below `0.5`, `play_song` type, playable metadata, exact-title evidence, and either artist evidence or a globally unique title. Single-character titles, pinyin-only evidence, homophones, edit-distance-only evidence, and artist-short-name-only input always fall back.

## Duplicate Titles

If the same title belongs to multiple canonical entities, a title-only query returns `ambiguous`. A full artist name or a unique conservative artist short name plus the exact title is required. Multiple query records for one canonical entity still count as one song.

A record without an artist forms a separate metadata entity. It cannot make a title shared by known artists appear unique.

## Lazy Migration

V1 records are indexed in memory without an eager storage rewrite. Records without a song name continue to support V1 exact lookup but are excluded from V2 entities.

After an old record succeeds through V1 or V2, the normal serialized `recordSuccess()` transaction stores `recordVersion: 2` and its canonical key. A V2 alias hit also learns the new query as a future V1 exact query while updating the matched representative.

## Transactional Writes

All mutations share a Promise write queue. Each operation waits for its predecessor, copies the committed Map, modifies and prunes the copy, writes a complete snapshot, and swaps the official Map only after a successful save. The entity index is then rebuilt from the committed Map.

This applies to success and failure recording, deletion, clearing, maximum-record changes, trimming, and automatic eviction. A failed save leaves the committed records and indexes unchanged. A rejected queue operation is caught so later writes can continue.

## Read Failure Protection

Storage loading distinguishes a missing key, a valid empty snapshot, a storage read error, and an invalid snapshot. Read and format errors put MemoryService in a degraded state: V1 and V2 miss, writes are refused, and the existing rule and AI paths continue.

An invalid record can be ignored without discarding valid records. A non-empty snapshot containing no valid records is treated as a format error and is never automatically replaced with an empty snapshot.

## Resource Impact

The configured maximum remains 10 to 1000 records. Alias count is bounded, edit-distance candidates are capped at 20, and pinyin uses the existing generated lookup map. The runtime does not initialize `segmentit` or `pinyin-pro` dictionaries.

The built-in pure self-test covers exact matching, entity aliases, duplicate titles, homophones, migration compatibility, mutation rollback, queue recovery, concurrency, index cleanup, and 10/100/1000-record performance.

## External Playback Limitation

No change is made to `online_searcher.ts`. Imported external playback currently returns only success to VoiceEngine, so some successful memories contain title and artist but no Songloft song ID. Those records receive a stable metadata canonical key and replay through the existing title-and-artist search path.

No-import direct playback never stores a temporary URL. If the resource cannot later be resolved by existing search, memory playback fails safely and falls back to the normal rule and external-search flow.

## Known Limits

- Pinyin uses a single generated reading per character and is candidate-only.
- Metadata keys cannot distinguish two versions with the same title and artist when no ID or album is available.
- Existing song-rule execution still returns after a matched rule even if that rule's playback fails; V2 does not broaden that historical behavior.
- VoiceEngine ordering, disabled-memory behavior, and playback fallback require runtime verification with real voice input in addition to the pure self-test.
