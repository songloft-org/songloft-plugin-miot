# AI takeover failure on HD speakers

Related: [songloft-org/songloft-plugin-miot#140](https://github.com/songloft-org/songloft-plugin-miot/issues/140). [中文](../issue-140.md).

## Evidence and limits

Read the body, screenshot, all comments (zero at inspection), and attached logs on 2026-11-15. Remote main and the local baseline were both `cd4921fde37f8239878cf1bb0b44fa074f6b481b`. The latest business release was v2026.11.12.0; successful CI for #138 does not mean this working tree has shipped.

The screenshot reports an AI conversation failure because the native answer could not be interrupted. The reporter says it actually stopped and another Xiaomi AI speaker on the same account works. Five AI tasks fail immediately after the first stop response in the attachment, including:

| Time (UTC+8) | Observed behavior |
| --- | --- |
| 11:54:26.696 | Model request starts |
| 11:54:27.044 | Stop returns outer `code=0`, device `data.code=123` |
| 11:54:27.045 | First interrupt round fails; the AI task fails and cancels its model request |
| 12:48:32.451 | Another task returns outer `code=0`, device `data.code=131`, and fails in the first round |

Other stops on that device also return `114`. All ten stop responses on the comparison device return `0`, and its AI tasks reach speech and completion. The code path is `AIChatService → PlaybackCoordinator.prepare → MinaService.interruptAnswer → playerStopGuarded → playerOperation`: a nonzero device stop code immediately fails without status verification or a second round, then cancels model work. This proves the software termination point and agrees with the reported successful interruption; it does not establish firmware error-code meanings or prove silence. The attachment lacks a complete HD firmware version and raw post-stop status responses, so behavior cannot be generalized to every firmware.

Original attachments remain under `/tmp/miot-140/private/` and are excluded from the repository. This record omits accounts, device IDs, credentials, network addresses, and original questions.

## Local change

Enable bounded verification only for the two-round answer interrupt: when the outer cloud request succeeds and the device stop code is a finite nonzero number, read at most two fresh statuses, 700ms apart. Both must be known non-playing states `0/2/3` with successful device status responses. Bypass pre-stop caching; no error-code whitelist is introduced.

After a verified first round, still wait 600ms and send the second `pause → stop` round. Feedback or answer dispatch waits for both rounds. Failed queries, missing/unknown states, playing, and cloud failures still fail. Check cancellation after waits and requests so late idle responses cannot advance an old task. Ordinary stop, pause, group-member stopping, and TTS acknowledgement semantics retain their behavior. Reuse `isDeviceIdle`; no global background polling is added.

This lets devices that have stopped and report that state continue AI takeover. Unavailable or persistently incorrect status reports can still fail and require actual HD responses for further investigation. Consecutive idle reports do not prove silence or audible TTS.

## Validation

2026-11-15, Linux x86_64 / Node 22.17.1 / TypeScript 5.9.3. The plugin baseline above plus uncommitted changes; parent repository `ebdbddedde6c47dc3ec8919b9be2f4e88815faab`. Source/test manifest SHA-256: `b8ebaf548b456f2ead85c684230ed5e98e5c97f246d26709876e1d45edc64740`. Per-file digests and object identity: `/tmp/miot-140/verification.json`.

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Passed |
| `node --experimental-strip-types --test tests/*.test.mjs` | 1475 passed |
| Interrupt suite | 51 passed; the identical suite against isolated baseline source has 21 expected failures |
| `npm run build` | Passed, including frontend and QuickJS bytecode |
| Final `npm exec -- songloft-plugin build` | Passed after restoring unrelated 2027 holiday changes downloaded by prebuild |
| `npm run validate` | Passed |
| TypeScript formatting / `git diff --check` | Passed |

Coverage includes `114/123/131` × `0/2/3`, playing/unknown/query failures, pre-stop idle caching, failed device status responses, cancellation during the verification wait and either in-flight read, the original two rounds with normal acknowledgements, and ordinary-control error semantics. An actual `AIChatService → PlaybackCoordinator → MinaService → MinaHTTPClient` chain prevents TTS before both verified rounds, then dispatches `text_to_speech` through simulated HTTP and completes the task. Model output and speech completion are fixtures, not physical audio evidence. Task, queue, and wait-timer cleanup are also asserted.

Evidence: `/tmp/miot-140/{baseline-final,interrupt-final,tests-final,typecheck-final,build,build-final,validate-final}.log`. The built package is a local test artifact without a newly assigned official version.

Not run: physical HD/firmware, the reporter's account or live cloud requests, actual silence/TTS, physical follow-up and music recovery behavior, long-running playback; browser interaction (no UI changes), parent Go checks (host interfaces and implementation unchanged), and remote CI for this fix (not committed/pushed). The full plugin suite retains playback, transitions, status, and recovery regressions.

Not committed, pushed, released, or posted to the Issue. The parent submodule is only dirty. Suggested commit: `fix(chat): 回读确认异常停止回执后继续 AI 接管 (#140)`. After release, ask the reporter to retest native-answer interruption, audible AI answers, and follow-up questions on HD; keep the Issue open pending hardware feedback.
