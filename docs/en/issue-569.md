# Voice song matching threshold and verification

Related: [songloft-org/songloft#569](https://github.com/songloft-org/songloft/issues/569). Plugin baseline: `48413d6abc2a34e8094bca3ec2f80457365b5abd`; parent baseline: `d5935c42d57dce17add89762e5a455a891d39bf0`. Only the plugin changes. Nothing has been committed, pushed, released, or installed on a real speaker. The parent shows a dirty submodule with its gitlink unchanged.

## Usage and behavior

Open Settings → Voice → Search → **Song matching threshold (0–100)**. The configuration key is `song_match_threshold`, default 70. Missing, nonnumeric, or nonfinite values use the default; numbers are clamped to 0–100. This score measures string matching strength, not a statistical probability. Higher values are stricter.

Voice song requests normalize traditional/simplified Chinese, case, punctuation, and individual Chinese/Arabic digits such as `九/9`. Matching combines character edit similarity and untoned pinyin syllables, without requiring AI or a model key. `cctv9记录` can match `CCTV九纪录`; the short title `记录` covers too little of the request and is rejected by the default threshold. A threshold of 100 requires an exact normalized title; zero still rejects candidates with no matching evidence.

- Local first searches externally only when there is no eligible local candidate.
- External first validates the returned song before playback and falls back locally after rejection or playback failure.
- Parallel search waits for both concurrent searches, tries higher scores first, and prefers local on ties. Failed playback reuses the remaining candidates from the same searches, avoiding duplicate searches/imports. Waiting for a slower source may increase latency; existing index waits and external timeouts still apply.

External song validation precedes importing, playlist additions, and playback. Playlist members, standalone songs, cache fallback, command previews, and retries after an invalid playlist refresh use the same threshold. Ordinary index searches and artist/playlist matching retain their existing rules; artist/playlist external fallbacks are not judged as song titles. Existing topone responses and external source ordering remain unchanged; this does not add multi-result external retrieval.

## Verification target and results

2026-11-15, Linux x86_64, Node 22.17.1, uncommitted plugin worktree. The diff identity and command results are stored separately in `/tmp/miot-569/verification.json`. Docker `browserless/chrome:latest` exercises the real configuration handler, ConfigManager, and isolated disk storage; host bridging and speaker interfaces use fixtures. The plugin compiles to QuickJS bytecode.

| Check | Result / evidence |
| --- | --- |
| `npx tsc --noEmit` | Passed; `/tmp/miot-569-typecheck.log` |
| `node --experimental-strip-types --test tests/*.test.mjs` | Passed, 1492 tests; `/tmp/miot-569-tests.log` |
| Frontend `npm run typecheck`, `npm test` | Passed, 84 tests; `/tmp/miot-569-frontend-{typecheck,tests}.log` |
| `npm run build --ignore-scripts` | Passed, including Vue build and QuickJS compilation; `/tmp/miot-569-build.log` |
| `npm run validate` | Passed; `/tmp/miot-569-validate.log` |
| Isolated old implementation | The new scorer remains available to avoid missing-module failures. Of 14 new regression tests against old business code, 13 fail on the intended behavior and the scorer check passes; `/tmp/miot-569-before.log` |
| All three priority execution paths | Real index, OnlineSearcher, and HTTP fixtures: a rule request selects radio 1933, invokes playlist playback, stops once, and neither imports the unrelated external song nor speaks a failure; included in the full suite |
| Desktop/mobile interaction | 1200px saves 85 and 390px saves 90; reloading preserves each value in the UI, disk storage, and a new ConfigManager. The threshold remains editable with external search disabled. No page script errors; `/tmp/miot-569/browser-result.json`, `ui-{1200,390}.png` |
| Formatting and review | TypeScript Language Service formats changed ranges; `git diff --check` passes |

The full `npm run build` prebuild fetched next year's holiday data. That unrelated generated change was reverted, and `--ignore-scripts` rebuilt the existing checked-in data. No holiday schedule changes are included. Source differences, package hashes, and logs establish local verification only, not a speaker upgrade.

Not run: real speaker models/firmware, the reporter's library and online sources, audible playback, long-running behavior, and remote CI. No reporter device/account is available, and nothing was committed or pushed. Parent Go regression checks are not applicable because neither host interfaces nor Go code changed.
