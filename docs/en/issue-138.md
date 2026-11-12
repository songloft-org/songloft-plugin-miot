# Group playback start skew

Related: [songloft-org/songloft-plugin-miot#138](https://github.com/songloft-org/songloft-plugin-miot/issues/138). [中文](../issue-138.md).

## Investigation and behavior

The report describes LX06 + OH2P starting out of sync after idle periods. At baseline `0cc6b92ea4804de0814850acda5d900def789f4e`, `MinaService.playURL()` unconditionally waits for `pause → stop` before looking up hardware, reading configuration and choosing an API. This path does not call `playerPauseVerified()`: the two 700ms verification waits mentioned in the Issue belong to explicit pause operations. The source establishes that two pre-stop cloud round trips independently postpone each member's play request. Without the reporter's raw logs or devices, it does not establish Wi-Fi sleep behavior or audible start skew.

Apply option A: `player_play_music` already sends `play_behavior: REPLACE_ALL`, so it replaces playback directly. Retain pre-stop for `player_play_url`, including models with Music API explicitly disabled and the final direct-URL fallback after lyrics playback failures. Explicit pause still verifies device state and escalates to stop when needed; explicit stop and two-round answer interruption retain their behavior.

Group playback also shares preparation:

1. Read members' hardware/configuration concurrently, complete lyrics searches and necessary direct-URL pre-stops. A member's preparation failure produces its own failed result.
2. Once preparation finishes, reserve each device's existing ubus queue and wait for requests already in flight. Faster members keep their reservation so background status queries cannot start before the new playback command.
3. Enqueue every member's initial playback command before releasing reservations in the same turn. Release through `finally`. Duplicate members prepare, reserve and dispatch only once while results retain the input order.
4. Playlists, DLNA groups, the temporary URL endpoint and online search without a playlist share this entry point. Temporary URLs no longer wait for the primary speaker's acknowledgement before starting followers.

Playlists still accept at least one successful member; DLNA still requires every member and stops the group after partial failure. Existing playback generation and client identity checks cancel late dispatch after stop, track changes, external takeover or account client replacement during preparation.

This reduces plugin-induced skew; it is not scheduled playback using a shared device clock. Network delivery, cloud retries, device buffering and fallbacks after failed lyrics playback may still introduce skew. Zero audible echo or millisecond acoustic synchronization is not promised. Mixed API groups wait together for direct-URL pre-stop, potentially increasing total startup latency.

## Verification

2026-11-12, Linux x86_64 / Node 22.17.1 / npm 10.9.2 / TypeScript 5.9.3; plugin baseline `0cc6b92ea4804de0814850acda5d900def789f4e` plus the uncommitted worktree, parent repository `c3ae379944ff1fb8afad0b541c7fafca6efb2d56`. Source/test manifest SHA-256: `aa44f6b94a604451af53be2fcc07070f2ed3db4ac8494bdb0340bcaea9eb9c8d`. Per-file digests: `/tmp/miot-138-source-manifest.json`; full delivery identity: `/tmp/miot-138-verification.json`.

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Passed |
| `node --experimental-strip-types --test tests/*.test.mjs` | All 1453 passed, including 21 new group cases |
| New cases against isolated baseline | 4 expected failures cover three Music API models' pre-stop removal and LX06 + OH2P dispatch through the actual playlist manager |
| Remove preparation barrier in isolation | 4 expected failures cover slow hardware lookup, lyrics search, direct pre-stop and an in-flight status query |
| Remove queue reservation in isolation | 1 expected failure covers a slow background query started during preparation |
| Remove direct-URL pre-stop in isolation | 2 expected failures cover mixed groups and lyrics fallback |
| Frontend `npm run typecheck` / `npm test` | Type check and all 84 tests passed, including slider/status regressions |
| `npm run build` / `npm run validate` | Passed, including frontend and QuickJS bytecode builds |
| Final `npm exec -- songloft-plugin build` / `npm run validate` | Passed after restoring unrelated downloaded 2027 holiday changes |
| TypeScript formatting / `git diff --check` | Passed |

Targeted cases use the actual `PlaylistManager → MinaService → MinaHTTPClient → ubus queues`, with fixtures at cloud HTTP, configuration and selected preparation inputs. A virtual clock simulates twenty minutes idle and an extra 1800ms LX06 pre-stop delay. Both members' play requests leave at the same virtual instant after the change. Separate cases verify slow preparation, acknowledgements, existing queries and queries started during preparation. Other coverage includes cancellation, invalidated accounts, member failure, duplicate members, seek/speed URLs, Music API payloads, direct fallback and explicit pause verification. This measures request dispatch, not acknowledgement gaps or audible playback.

Logs: `/tmp/miot-138-{typecheck,tests-final,frontend-typecheck,frontend-tests,build,build-final,validate-final}.log`; negative verification: `/tmp/miot-138-final-negative-j1ej5b2l/`.

Not run: actual LX06/OH2P firmware, audible starts after ten to twenty minutes idle, old-track tails and device behavior after voice interruption, and long-running playback; no devices are available. Browser interaction was not run because there are no UI changes. Host APIs, Range, transcoding and Go implementations are unchanged, so parent Go checks are not applicable.

The verification above describes the pre-commit worktree: no commit, push or official release at that point, remote CI Not run, and the parent gitlink at baseline. Commit, release and exact-SHA CI results will be recorded after delivery. Suggested commit: `fix(player): 减少分组起播时差并跳过 Music API 预停 (#138)`.

## Commit and release

- Fix: [3ff97c0](https://github.com/songloft-org/songloft-plugin-miot/commit/3ff97c06ef202f30a5a94ae3246d678ab9e7b61f), pushed to main; release metadata commit `94241389a57ac44461108f6067590327090f92dd`.
- [Release Plugin CI](https://github.com/songloft-org/songloft-plugin-miot/actions/runs/43195481406) passed for the exact fix SHA and automatically published [v2026.11.12.0](https://github.com/songloft-org/songloft-plugin-miot/releases/tag/v2026.11.12.0).
- Downloaded the official package and verified `version=2026.11.12.0` and `releaseSource=3ff97c06ef202f30a5a94ae3246d678ab9e7b61f`. Its SHA-256, `a3aee5f82a04cd988f8986d466c1af195051cf47595eb32d33c2ec9cdbf8a52e`, matches GitHub's asset digest. Package and manifest: `/tmp/miot-138-release/`.
- Update the MIoT plugin to `2026.11.12.0`, then test LX06 + OH2P group track changes and playback after ten to twenty minutes idle. No new switch is required. Updating the host alone does not automatically update installed plugins.
- Audible playback, old-track tails, device behavior after voice interruption and long-running operation remain Not run. Keep the Issue open for device feedback; release success does not establish acoustic synchronization.
