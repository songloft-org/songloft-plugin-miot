# Temporary artist continuation queues for standalone songs

Related: [songloft-org/songloft-plugin-miot#130](https://github.com/songloft-org/songloft-plugin-miot/issues/130#issuecomment-6393443720). [中文](../issue-130.md).

## Behavior

- Requesting a song outside all playlists plays the matched song first, followed by other library songs by the same artist. Newly imported search results and direct links with “play without importing” enabled share this path. Successful takeover of a configured destination playlist still plays that playlist.
- The queue appears as “歌手: name” through the existing temporary playlist endpoints and frontend, supporting song selection, previous and next. Missing artist metadata or other matching songs leaves only the requested song. Radio entries do not expand into artist queues.
- Candidates come from the current song index, bounded by `max_song_index`, including songs outside playlists. Matching compares normalized full artist fields, supports simplified/traditional Chinese and case differences, and deduplicates song IDs. It does not use fuzzy voice artist matching or fetch online artist catalogs.
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
