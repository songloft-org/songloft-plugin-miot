# #136: intermittent playback after a voice stop (investigation)

Tracks [songloft-org/songloft-plugin-miot#136](https://github.com/songloft-org/songloft-plugin-miot/issues/136) and its [log comment](https://github.com/songloft-org/songloft-plugin-miot/issues/136#issuecomment-6556355696). [中文](../issue-136.md).

## Log evidence and findings

Attachment: `songloft-logs-20261101-175002.zip`, SHA-256 `701a9ffc8cf386242b845d2109f7b5a98424947a81c6c4123904736d4617ba9c`. Times below are November 1, 2026, UTC+8; line numbers refer to extracted `backend.log`.

| Time | Lines | Behavior |
| --- | --- | --- |
| 12:35:54–12:35:55 | 655–692 | Metadata deadline advances index 92 to 93 and registers a 226-second timer; the screenshots show an automatic transition |
| 12:39:42–12:40:12 | 741–766 | Device plays foreign media lasting about 60 seconds; queue advances after 30-second grace. Foreign media does not prove the current song ended |
| 12:40:14 | 805 | Registers a 211-second timer for index 94 |
| 12:40:25 | 815 | `status=3, position=0, duration=0, playable=true`, accepting a blind landing |
| 12:40:35 | 820 | `External stop ignored: device reports no usable state`, ignoring idle with zero media details |
| 12:43:46 | 869–908 | `status=3, hasPosition=false`, actually pushes the next song at the metadata deadline |
| 12:45:45 | 973 | Backend starts as `v2.11.6`, commit `c5df438` |
| 16:57:09–17:00:49 | 9625, 9669–9701 | Ignores `status=3` again and pushes the next song at deadline; temporary improvement after restarting does not establish a fix |

Confirmed plugin path: ignored device state → retained transition timer → next URL at deadline. HEAD success proves server availability, not audible playback.

Captured new conversations contain song and reminder requests, but no stop command or successful plugin `stop()` execution in these intervals. Some earlier logs retain WARN only, and raw responses are missing. The exact phrase/time, why the command did not reach the plugin, and whether normal S12 playback continuously reports 3 remain unverified. `status=3` alone cannot establish that the speaker had actually stopped.

## Historical and code checks

Searched all main and plugin Issue listings (522 and 105 entries), then retrieved relevant bodies and all comments from the local AGENTS regression checklist, including main #408/#449/#495/#503/#533 and plugin #95/#96/#103/#124/#129.

- [Main #408](https://github.com/songloft-org/songloft/issues/408#issuecomment-5356048192): some native shutdown commands never appear in cloud conversation records. Background device-state detection was added to cancel auto-next.
- [Main #449](https://github.com/songloft-org/songloft/issues/449#issuecomment-5580502985): devices repeatedly misreport stopping; retain progress-based protection.
- [Plugin #129](https://github.com/songloft-org/songloft-plugin-miot/issues/129#issuecomment-6357481641): OH2 reports zeros during audible playback. `2fce927` / v2026.10.23.0 introduced `isBlindIdleState()` for idle 0/2/3, bypassing external-stop confirmation when a stream has never reported positive position or duration. The reply explicitly documents indistinguishable zero-state external stops retaining metadata timers. Current main uses the same condition.
- Current `MusicCommandService.executeStop()` cancels voice recovery and sleep timers, then `PlaylistManager.stop()` clears transition checks and reload anchors. Native speaker stop and successful plugin stop must be investigated separately.

This report confirms the #129 compatibility branch. Do not simply remove zero-state compatibility, globally treat 3 as a reliable stop, or assume one playing sample makes subsequent states reliable. Compare raw normal-playback and deliberate-stop responses on the same device first. No production logic changed in this task.

## Voice latency is separate

Backend `v2.11.6 / c5df438` still uses a fixed 500ms ticker in `runTimerProcessor()`, lacking timer-handle fix `32ff4ca` and event-driven pump `5d2368d`. This can add background async waiting; it is not the confirmed cause of every delay.

At 16:29:47–16:29:55, local and online lookup miss, taking about eight seconds in search. Online search at 16:30:17–16:30:27 takes about 10.5 seconds. A local hit at 16:31:14 takes about 2.5 seconds from search to dispatch. After 17:03 there are also status timeouts and push-verification failures. Investigate search, cloud requests, host scheduling and actual sound separately; HTTP success or 206 does not confirm sound.

On November 1, 2026, official releases queried were [Songloft v2.13.7](https://github.com/songloft-org/songloft/releases/tag/v2.13.7) and [MIoT v2026.11.1.1](https://github.com/songloft-org/songloft-plugin-miot/releases/tag/v2026.11.1.1). Updating the plugin does not update its host. Updating the backend includes existing runtime fixes, but there is no evidence it resolves the ambiguous zero-state stop.

## Verification and limits

- Date/environment: November 1, 2026, Linux amd64 / Node 22.17.1.
- Plugin baseline and independently checked remote main: `3f7a5420186b3756f078427e1c5aa6fc98d1f576`; parent: `57543b788b1be6ec4f37a2c28c481ec3707f287e`. Investigation and lesson documents only; source and tracked tests unchanged.
- Copied `player_failures.test.mjs` outside the repository, loading baseline source. Four investigation cases cover zero-detail idle 0/3: without plugin stop, the same track remains until the 211-second deadline, then the next URL is actually pushed. Explicit `stop()` prevents further pushes for ten minutes. Checks include queue state, failure markers, TTS and timer cleanup.

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --test --test-name-pattern='issue 136 investigation\|issue 129' /tmp/songloft-miot-136-20261101/repro/tests/player_failures.test.mjs` | 10 passed: four investigation cases and six existing #129 cases; proves behavior, not a fix |
| `node --experimental-strip-types --test tests/player_failures.test.mjs tests/player_transition.test.mjs tests/player_status.test.mjs tests/mina_status.test.mjs` | 649 passed |
| Frontend: `node --test tests/slider_drag.test.mjs tests/status_recovery.test.mjs tests/playback_failures.test.mjs` | 16 passed |

Evidence: `/tmp/songloft-miot-136-20261101/`, including attachment, historical Issue snapshots, isolated reproduction, `repro.log`, `playback-regression.log` and `frontend-playback.log`. Raw attachments are not committed; credentials and device identities are omitted.

Not run: physical S12, firmware raw-state comparison, actual stop phrase/audible timing, extended playback; full suite, typecheck, build/package validation, parent Go checks and browser UI (no production or UI changes). No commit, push or release. No Actions run directly tied to the baseline version-commit SHA was found; this is not CI-pass evidence.

## Initial reply draft and delivery

Target: `songloft-org/songloft-plugin-miot#136`. Keep the Issue open.

On 2026-11-01, after explicit user authorization, rechecked the latest comments and both official releases, then [posted and read back the reply](https://github.com/songloft-org/songloft-plugin-miot/issues/136#issuecomment-6556651500). It asks the reporter to separately update Songloft to v2.13.7 and MIoT to v2026.11.1.1, confirm actual running versions, enable debug logging, and record the exact stop phrase and reproduction times. It explains that updating does not establish a fix and leaves the Issue open. The earlier draft follows; the link contains the actual published text. Evidence: `/tmp/songloft-miot-136-20261101/reply-published.json`.

> The logs show the playback path: at 12:40:35 the speaker reports idle with zero media details. The plugin treats this as unreliable and retains its timer; at 12:43:46 the deadline pushes the next track. This relates to the October 23 compatibility change for zero-reporting speakers. Some speakers report zeros during normal playback, so stopping on every zero report would break those devices.
>
> The backend in the log is **Songloft v2.11.6**. Please update the backend and MIoT plugin separately before retesting. Plugin updates do not include host async-scheduling fixes, and updating alone does not establish that the stop issue is resolved.
>
> Enable the plugin's “Voice settings → Debug logging” and record accurate times for normal playback, the stop command and unexpected restart. Include the exact stop phrase, speaker firmware and updated backend/plugin versions. Check whether the stop appears in plugin conversation records. This attachment does not capture it, so we cannot distinguish a missing command from subsequent execution failure.
>
> Temporarily use Stop on the MIoT playback page. Explicit plugin stop clears automatic-transition timers in the local simulated comparison; physical S12 behavior still needs verification. Keeping this Issue open.
