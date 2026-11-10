# All songs virtual playlist

Related: [songloft-org/songloft#561](https://github.com/songloft-org/songloft/issues/561#issuecomment-6758336062). [中文](../issue-561.md).

## Behavior

- The playback playlist selector starts with “全部歌曲” (All songs), containing local and remote library songs and excluding every `type=radio` entry, including non-live radio. No stored playlist or copied membership is required.
- Each load reads ascending IDs in pages of 1000 until the unfiltered page is shorter than a full page. The voice index's `max_song_index` limit does not apply. A full page containing only radio still advances to the next page.
- Supports web song selection, random playback, track changes, saved progress and plugin reload restoration. Reload prefers the saved song ID when library membership changes its index.
- Scheduled tasks can select the virtual playlist ID; voice playlist lookup accepts “全部歌曲”. Starting-song lookup uses the same filtering and ordering.
- This entry is read-only: row removal is hidden, fullscreen removal is disabled, and the backend rejects member removal. External search append targets include only writable stored playlists. Manage songs in the main application's library.

The fixed identity is the plugin-reserved `Number.MAX_SAFE_INTEGER`, separate from negative device temporary queue IDs. The virtual ID never reaches stored playlist host APIs. Reloading or starting the playlist reads current membership; an active queue retains its loaded snapshot.

## Verification

2026-11-11, Linux amd64 / Node 22.17.1; plugin baseline `1379528daab3841e7e3ca0edb05d14046ff14a17` plus the uncommitted working tree, parent repository `cda7928858f2e99045f7b76f8f3ba691e10b48da`. The source/test content manifest digest is `e83a3084657895f140f1d0d259d557939ff86d768f612637eb888116edf8609b`; the local package SHA-256 is `cccc151f7f8f3851d1562909dea5c861708b3bb275905449d42d94e435d4f186`. Per-file digests, environment and verification identity: `/tmp/miot-561-verification.json`.

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Passed |
| `node --experimental-strip-types --test tests/*.test.mjs` | All 1432 passed, including 9 new virtual playlist regressions |
| New targeted tests against isolated baseline | 7 expected failures demonstrate missing entry, playback, restoration and read-only protection |
| Remove radio filtering in isolated copy | 6 failures confirm coverage detects radio entering counts and queues |
| `npm run build` / `npm run validate` | Passed, including frontend build and QuickJS bytecode compilation |
| Final `npm --ignore-scripts run build` / `npm run validate` | Passed; retains checked-in dictionaries and holiday data without unrelated prebuild downloads |
| Frontend `npm run typecheck` / `npm test` | Type check and all 84 tests passed |
| Docker Chrome 121, 1200×850 / 390×844 | Two songs shown, radio absent; actual song selection, previous, random mode and next clicks verified against the real manager and URLs; row removal absent, fullscreen removal disabled, zero page exceptions |
| `git diff --check` | Passed |

The browser uses the built frontend, actual playlist handlers and playback manager; library bridges, accounts and speaker controls are fixtures. Assertions go beyond screenshots: `/tmp/miot-561-browser-report.json` records actual song IDs, mode, persisted state and pushed URLs. Screenshots: `/tmp/miot-561-{desktop,mobile}.png`. Logs: `/tmp/miot-561-{tests,before,mutation,frontend-tests,typecheck,frontend-typecheck,build-final,validate}.log`.

Not run: physical speakers/firmware, audible playback, long-running playback, remote CI and official release. No host API or Go changes; parent Go checks are not applicable. This work is uncommitted, unpushed and unpublished; the parent gitlink is unchanged.
