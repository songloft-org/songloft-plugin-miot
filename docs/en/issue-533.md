# #533: Resume after voice sleep-timer controls and avoid duplicate confirmations

Tracks [songloft-org/songloft#533](https://github.com/songloft-org/songloft/issues/533). [中文](../issue-533.md).

## Logs and cause

The report lists Songloft 2.13.0 / MIoT 10.16.1; the attachment identifies an L15A. At 07:53:57 and 08:28:49, `songloft-logs-20261022-083024.zip` records “stop playing in half an hour” matching `sleep_timer`, successfully setting a 30-minute timer, and sending confirmation TTS. External stops are confirmed at 07:54:15 and 08:29:31, with no voice recovery task for these controls. The log does not show either timer expiring early.

Rule and AI branches speak when setting, querying, or cancelling timers, but `tryResumePlayback` only handled volume, play mode, and favorites. After a voice wakeup interrupted URL playback, these three controls neither protected the interruption position nor started recovery. Device monitoring eventually classified idle as an external stop.

The cloud conversation timestamp is 08:28:43.755, and the monitor receives it at 08:28:49.103, approximately 5.35 seconds later. Plugin TTS starts at 08:28:49.130 and is acknowledged at 08:28:49.617. The native answer already says it will stop playback in 30 minutes, yet the plugin confirms again. These timestamps do not establish the actual interval between audible replies.

## Behavior

- Rule and AI set/query/cancel timer controls suspend end detection and save the position before speaking, then use the existing `VoiceResumeCoordinator` to confirm progress or replay the current song.
- A `finally` block allows recovery even if confirmation TTS fails. Playback revision changes, timer expiry, newer conversations, pause, or track changes invalidate old recovery. Previously paused devices remain paused.
- Time-based timers skip duplicate TTS only when this conversation's native answer explicitly confirms the same number of minutes. Empty, failed, ambiguous, different, or unsupported compound-duration replies retain plugin confirmation. Song-count timers retain plugin speech.
- Existing recovery preserves seek, speed, real progress checks, cache/failure backoff, and natural next-track behavior. Conversation polling frequency and host APIs are unchanged.

## Validation target and results

- Date / environment: 2026-10-22, Linux amd64, Node 22.17.1, Go 1.26.0, local uncommitted working tree. Cloud/device states and time use controlled fixtures.
- Plugin baseline: `b49a4a6a6902ed1778a4660782431bc2ab545381`. Read-only comparison against remote `22cc42dcbd992782ab0e64becdb49a5eb6a0f886` found only 2026.10.21.0 version metadata changes.
- Parent: `11e772580d83608b5a1ea3ca7597eb0c1da8b1fe`; no Go or recorded gitlink changes in this task. The plugin is dirty.
- Code identifier: SHA-256 of `git diff -- src/music/service.ts tests/player_failures.test.mjs` is `e88f62257c3bff22bb880761c84b7ba0aa5201aaef15c53ccabfc395d0ea8b66`. This covers source/tests only, excluding this record and lessons.

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Passed |
| `node --experimental-strip-types --test tests/*.test.mjs` | 1256 passed |
| `node --experimental-strip-types --test-name-pattern='issue 533' tests/player_failures.test.mjs` | 55 passed, including status page on/off, seek/speed, actual recovery URLs, natural next track, time/song expiry, cancellation by newer controls, and TTS failure |
| Same 55 tests against baseline `src/music/service.ts` in an isolated directory | 46 failed for the target behavior; 9 passed. Working-tree source was not overwritten |
| `npm run build` / `npm run validate` | Passed; `main.jsc` explicitly generated |
| Frontend `node --test tests/slider_drag.test.mjs tests/status_recovery.test.mjs tests/playback_failures.test.mjs` | 16 passed |
| Parent `CGO_ENABLED=0 make check` | Passed, including formatting, vet, and full Go tests |
| Parent `CGO_ENABLED=0 go test -tags dev,lite ./internal/jsruntime ./internal/jsplugin ./internal/services ./internal/handlers -run 'Timer\|Play\|Seek\|Stream\|Range'` | Passed |
| TypeScript formatting and `git diff --check` | Passed |

The initial sandboxed Go check failed because its build cache was read-only; the approved run outside the sandbox passed. The initial sandboxed package skipped `jsc`; the approved rebuild explicitly compiled bytecode and supplies the final package. Node results likewise use individual test results from outside the sandbox.

Logs: `/tmp/songloft-533-{suite,after,isolated-before,integrated,integrated-before,build,validate,frontend-playback,backend-check,backend-targeted}.log`. File SHA-256 of local `dist/miot.jsplugin.zip`: `b7dc3bec3b0633ed4c91b44d801f775e12a7c948ba8b7d832bc3c2f67945ef4b`. It retains baseline version metadata and is not a public new version.

## Historical fix review (2026-10-22)

Voice and hourly recovery have required repeated fixes. The [final device feedback on #481](https://github.com/songloft-org/songloft/issues/481#issuecomment-6207075183) confirmed recovery in approximately six seconds at that time. In the corresponding `1fdcecdb63a5c521347dd97e7fd82f524d78142a`, the recovery list at `src/music/service.ts:1040` still includes only volume, play mode, and favorites. Timer controls were not connected. Device acceptance for #481 therefore does not establish acceptance for #533.

This review strengthens tests without further production-source changes. It adds 24 integrated scenarios through the real ConversationMonitor, VoiceDispatcher, guarded music engine, VoiceResumeCoordinator, MinaService, and MinaHTTPClient, with fixtures only at cloud I/O boundaries. Coverage includes Music API/direct URL, status page on/off, 0.5/1/2 speed, and idle 0/3, including conversation idle backoff, shared status caching, half-second cloud responses, and an eight-second announcement. Each asserts no push before speech ends, an actual saved-position recovery URL, no duplicate confirmation, and two subsequent natural transitions with correct URLs, no failure markers, and active timers. All 24 pass with the fix and fail against isolated old source because no recovery URL is sent. All 55 targeted and 1256 full tests pass.

This strengthens evidence for the missing entry point and compatibility across the call chain; audible device playback and coexistence with native firmware timers still require device acceptance.

## Delivery limits

Pre-commit revalidation: fast-forwarded to remote `22cc42dcbd992782ab0e64becdb49a5eb6a0f886` without changing the source/test diff identifier. Type checking, 1256 plugin tests, all 68 frontend tests and frontend type checking, QuickJS build, and package validation passed again. Logs: `/tmp/songloft-533-final-{suite,frontend,build,validate}.log`. This local package still uses version 2026.10.21.0; file SHA-256 is `fffc5bafc0b08aff03f1edc2ec9b3cfb364de3d2e0809530cfbe35713cf68ec2`. Verify the automatic release package separately against its `releaseSource`, version, and downloaded file.

Not run: audible L15A playback, coexistence of firmware-native and plugin timers, real cloud conversation latency, long-running use, remote CI, or official release. There are no frontend interaction changes; browser operations were not run. Automation does not establish actual silent intervals; the reporter's device still needs verification.

The above records local validation; no installation on a real speaker. Subsequent commits, CI, automatic publication, and replies are tracked in the delivery comment on #533. Keep the Issue open pending device acceptance. Commit: `fix(voice): 修复语音定时后的续播并避免重复确认`, with `songloft-org/songloft#533` in the body.

## 2026-10-27: No recovery after a native alarm/reminder (investigation, unfixed)

The [new report](https://github.com/songloft-org/songloft/issues/533#issuecomment-6432369965) describes music failing to resume after dismissing a 10:35 alarm. Acceptance of the earlier sleep-timer fix does not establish support for native alarms.

The attachment `songloft-logs-20261027-103641.zip` (SHA-256 `6c1b06f8d1b7c8919b462c50a4d827ed286a20f9af9c1a882bc77d349a4b5fa3`) records:

- At 10:31:33, a resume command restarts the current song. At 10:31:54, “remind me to check my phone at 10:35” arrives with a native reply confirming that time.
- At the same time, landing verification reports `status=0`, marks that song unplayable, advances, and registers a 306-second timer. This is a separate interruption while setting the reminder; missing raw state prevents attributing it to the same cause as the later stop.
- At 10:35:46, `External stop confirmed (status=0, position=0s), cancelling auto-next` is followed by `Playback stopped pushToDevice=false`. This occurs approximately 230 seconds after timer registration at 10:31:56, before its 306-second natural deadline. External-stop detection causes the stop.
- The relevant interval contains no dismissal conversation, raw `player_get_play_status` response, or subsequent recovery URL. The stop log omits `hasPosition`; zero alone cannot distinguish a real reset from missing media details or establish when the alarm ended.
- The last recorded MIoT update is `2026.10.22.0` on October 22. This is not independent verification of the user's current installed version.

Both release source `f65146c762a11000ce9a12866fbbc742e027de26` and current main `b1d25e133aa547652ebb80cabc0b0264603d8d42` only attempt hourly recovery when `hourly_chime_resume_enabled` is enabled and the interruption falls within 90 seconds after the hour. 10:35 is outside that window. There is no native alarm/reminder state detection. Extending the window or automatically resuming every idle state also changes the meaning of deliberate button/App stops. Recovery after setting a reminder and recovery after its future ringing require separate handling.

On 2026-10-27, Linux amd64 / Node 22.17.1, a copied test runner outside the worktree loaded current main sources. A synthetic 10:35:06 case with confirmed playback, 190 seconds elapsed in a 306-second song, and consecutive fresh idle samples reproduced the same stop at 10:35:46: `stopped`, no recovery URL, and no next-track timer, even with hourly recovery enabled. This proves the existing branch behavior, not real device state or audible playback. It and three existing window/stop guards passed:

```bash
node --experimental-strip-types --test --test-name-pattern='issue 533 alarm at 10:35|outside the 90-second window|ordinary stop cadence' /tmp/songloft-533-alarm-20261027/repro/tests/player_failures.test.mjs
```

Evidence is under `/tmp/songloft-533-alarm-20261027/`: the attachment, `logs/`, `repro/`, and `repro.log`. Production source and repository tests are unchanged. Parent baseline: `f15c0c919693e508fc91dc0448a7304af7d219a9`; existing dirty Lynx changes were preserved.

Next, use the existing Voice Settings debug-log switch to capture raw state without adding queries or changing control behavior. Record reminder setup, ringing start, dismissal method (exact spoken command/button/App), ringing end, and manual resume times, plus a deliberate pause for comparison. Check whether actual responses expose usable alarm identity or state before defining recovery conditions; alarm fields in a cloud device protocol do not prove that this firmware returns them through ubus. A spoken “stop” dismissing an alarm must also be distinguished from stopping music.

Not run: physical L15A, raw alarm/reminder state capture, interruption during reminder setup, latest-plugin device retest, long-running playback, full build or test suite (investigation and documentation only). At the investigation stage, no commit, push, release, comment, or Issue closure was performed.

Follow-up decision on 2026-10-27: the user chose a direct reply recommending “continue playing” after dismissing the alarm, without expanding automatic recovery. The authorized [Issue reply](https://github.com/songloft-org/songloft/issues/533#issuecomment-6432806582) was posted and read back, explaining state-identification limits and the manual workaround. The Issue remains open. If manual recovery also fails, request its time and logs. This task preserves investigation documentation only, with no production behavior change or plugin release.
