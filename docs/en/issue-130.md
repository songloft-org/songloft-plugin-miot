# Temporary artist continuation queues for standalone songs

Related: [songloft-org/songloft-plugin-miot#130](https://github.com/songloft-org/songloft-plugin-miot/issues/130#issuecomment-6393443720). [中文](../issue-130.md).

## Behavior

- Requesting a song outside all playlists plays the matched song first, followed by other library songs by the same artist. Newly imported search results and direct links with “play without importing” enabled share this path. Successful takeover of a configured destination playlist still plays that playlist.
- The queue appears as “歌手: name” through the existing temporary playlist endpoints and frontend, supporting song selection, previous and next. Missing artist metadata or other matching songs leaves only the requested song. Radio entries do not expand into artist queues.
- Candidates come from the current song index, bounded by `max_song_index`, including songs outside playlists. Matching compares normalized full artist credits and supports pairs such as `Eric周兴哲` and `周兴哲`, where one credit has a Latin-script prefix or suffix. It handles simplified/traditional Chinese and case differences, preserves separators between artists, and deduplicates song IDs. Candidates come from the local index.
- Full song details load with at most four concurrent requests, retaining URL, type and duration. Deleted/unreadable entries do not prevent the requested song from playing. Stop, newer playback, voice cancellation and external takeover invalidate delayed results.
- The device's playback mode applies: order, random and list repeat use the same queue; repeat one repeats the current song, while play once pauses after it ends.
- Imported queues persist their artist source, initial requested song ID and current song ID. Reload rebuilds the queue and restores selection without automatically pushing audio. Selecting another song in the same frontend list retains the queue source. Temporary direct links do not persist a restore marker, avoiding replay of expired URLs. All temporary queues clear the previous real playlist and reload resume anchors.
- Songs without a valid duration retain the existing device progress probes; no artificial completion deadline is introduced.

## Cause and validation

The report's log creates a `mode=order total=1` queue for song 311 at 2026-10-25 11:50:34. Its timer fires normally at 11:55:27 and records `No next song, playback complete`. The old implementation always used a one-song ordered queue for standalone songs without generating artist candidates. This differs from the user explicitly choosing play-once mode.

Validation targets plugin baseline `cd32b8ffb0b69a2a6ae4d32bf56c712f7a941b13` plus this uncommitted working tree, with parent repository `ccfcdf92426969dbc489876057978eddc7b24736`. Environment: 2026-10-25, Linux amd64, Node 22.17.1, Go 1.26.0. The source/test diff SHA-256 is `b8f9d11cafac33f90c0b2046b41b7fdc919df883fa7cde373cda4c4b9fcda5f7`; the local artifact SHA-256 is `7ffb2f1960fdf23615d921bce089f9140382aaf9c9ac37a2e6411f864b61af7e`. Both are also recorded in `/tmp/songloft-miot-130-20261025/verification.json`.

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Passed |
| `node --experimental-strip-types --test tests/*.test.mjs` | 1282 passed, including player status, transitions, Mina and voice recovery regressions |
| New queue regressions against isolated baseline sources | 14 failed, covering the old one-song queue and missing library candidate loading/restore metadata |
| `npm run build` / `npm run validate` | Passed, including QuickJS bytecode compilation |
| Frontend `npm run typecheck` / `npm test` | Passed: contract checks and 72 tests; plugin build runs frontend compilation |
| Parent `CGO_ENABLED=0 make check` | Passed: formatting, vet and full Go tests |
| Docker Chrome 121 at 1024×768 / 390×844 | Real frontend displayed the temporary “稻香 → 晴天 → 七里香” list. Selecting 七里香 made the real queue manager record its URL, with correct selection/restore metadata and zero page exceptions |

New regressions assert no transition one millisecond before the requested song ends, then check the actual next URL, absence of failure markers/TTS and a live subsequent timer. They also cover natural completion of a non-imported seed, graceful fallback, concurrency limits, cancellation, frontend song selection and stable ID restoration after reload. Browser verification uses the real index, configuration, player manager and playlist handlers; songs, accounts, device samples and playback output are fixtures, not evidence of audible hardware playback.

Logs, negative validation, browser scripts, JSON and screenshots are under `/tmp/songloft-miot-130-20261025/`. Not run: the reporter's speaker/firmware and original audio, long-running playback, remote CI and official publication. This section records local verification before committing; subsequent commit, CI, publication and reply status is tracked in the Issue delivery record.

## October 26 speaker follow-up

- All three requests for 《你，好不好？》 matched the local credit `Eric周兴哲` and created an ordered queue with `total=1`. The old full-field comparison misses other songs credited as `周兴哲`. The log does not enumerate the library's artist credits, so the reporter's library still needs to be checked for the exact missing tracks. [Follow-up report](https://github.com/songloft-org/songloft-plugin-miot/issues/130#issuecomment-6418357065)
- Two transitions showed metadata lengths of 297.552s and 262.920s, while the device reported 310.242s and 537.340s. The server received another stream request for the same song at the tail, and the device's position returned to the beginning. The plugin waited out its 30-second verification grace before sending the next track. Adjacent fresh samples now check the timing of the rewind, stable reported duration, and tail position. Tail probes still cover the metadata end when the main timer defers to the longer duration. Continued forward progress retains the existing end verification. [Follow-up report](https://github.com/songloft-org/songloft-plugin-miot/issues/130#issuecomment-6418357065)
- At 20:20:23, the ordered queue had no next song and the device pulled the stream again after resetting its position. The old path updated only local state. An observed replay at the end of an ordered queue or play-once session now stops playback through the existing device control path. Explicit repeat-one and repeat-list modes continue according to their settings. A metadata deadline or ambiguous device status alone retains conservative completion behavior.
- To turn off the indicator, disable the keep-indicator-on setting under advanced device compatibility. That option also affects some models' native playback recovery after voice announcements. The light and voice recovery behavior still needs hardware verification by model. [Indicator light and voice recovery history](https://github.com/songloft-org/songloft/issues/171)

### Local verification

Verified on 2026-11-18 with Linux amd64, Node 22.17.1, and Go 1.26.0 against plugin baseline `ec8c2e0f58ebc3d5dc9921b284bb02b089a8ce6a` plus the local working tree. The source and test diff SHA-256 is `4f6c7aa9c5af628e02344ce47de7d990cbaa2136dda7d4876cd11aaa1fb731de` and the package SHA-256 is `f1cf285653272fe8c55464fab9653b2b29c15760455b27c4f68fa7ff00be2b2d`. Host checks use parent `b5ecf54f42324076d5d174138a7da4bbea37fb51` plus its existing working tree.

| Check | Result |
|---|---|
| `node --experimental-strip-types --test tests/*.test.mjs` | 1533 passed, including 22 focused cases |
| Focused cases against isolated old sources | 20 failed for the intended behavior and the two explicit repeat modes passed |
| `npx tsc --noEmit`, `npm run build`, `npm run validate` | Passed, including Lynx/Web bundles and QuickJS bytecode |
| Frontend `npm run typecheck`, `npm test` | Passed, including 138 tests |
| Host `CGO_ENABLED=0 make vet test` | Passed, along with targeted playback, Range, seek, and timer checks |

Integration cases use Mina command construction and the shared cache, covering the URLs of two natural transitions, Music API and direct playback, with and without the status page, seek, and 0.5/1/2× speed. Device responses, time, and audio requests use fixtures. Logs are under `/tmp/songloft-miot-130.UKT0C0/`. Not run: the reporter's speakers and firmware, original audio, physical indicator lights, long-running playback, and remote CI for this working tree. This is a local fix.
