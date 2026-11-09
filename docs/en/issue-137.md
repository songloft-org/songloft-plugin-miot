# #137: Confirmed unprefixed AI routing and clearer settings

For [songloft-org/songloft-plugin-miot#137](https://github.com/songloft-org/songloft-plugin-miot/issues/137). [中文](../issue-137.md).

## Latest confirmation and local changes (2026-11-09)

The reporter [confirmed](https://github.com/songloft-org/songloft-plugin-miot/issues/137#issuecomment-6738703661) that only enabling the unmatched-music-command fallback causes unprefixed interception. They [then explained](https://github.com/songloft-org/songloft-plugin-miot/issues/137#issuecomment-6738782369) that the label sounds like fallback after a failed song lookup. The previously suspected configuration entry is now confirmed by the reporter; the same configuration screenshot is no longer required.

Routing checks whether the music service recognized and handled the utterance, rather than whether a song search returned results. With this switch enabled, ordinary weather questions and casual conversation enter chat when not recognized as music commands. Fixed controls and recognized music requests retain priority, and recognized requests that fail playback do not become chat. The reporter's description of “all speech” must not be generalized to music controls losing priority.

Locally renamed the switch to “无需触发词也交给 AI” (allow AI without a trigger) and moved it from advanced model settings next to triggers and continuous follow-ups. The description covers weather, casual conversation, and independence from the follow-up window. The `fallback_enabled` key, default-off value, existing selections, and runtime routing are preserved. Both AI chat guides explain that requiring a trigger for every turn means disabling this switch and continuous follow-ups.

Validation target: plugin baseline `a161d3a1d6cc3159219b15f215d0c3f865442c85` plus the uncommitted working tree; parent baseline `b35fc09e52bf4404ba9dfb1e7e999066ae844b1d`, with its gitlink unchanged. Environment: Linux x86_64, Node 22.17.1, Docker Chrome 121. File SHA-256 values and command results: `/tmp/miot137-wording-20261109/verification.json`; logs and screenshots share that directory.

| Command / scenario | Result |
| --- | --- |
| `npx tsc --noEmit` | Passed |
| `node --experimental-strip-types --test tests/*.test.mjs` | 1,423 passed, no failures/skips |
| frontend: `npm run typecheck`, `npm test`, `npm run build` | Passed; 84 tests, no failures/skips |
| `npm run build`, `npm run validate`; final `npm --ignore-scripts run build`, `npm run validate` | QuickJS bytecode build and package validation passed; reverted unrelated holiday data downloaded by the initial prebuild, then rebuilt with repository data |
| Docker Chrome 121, 1200px / 390px | New label and description visible without opening advanced settings; toggle/save/reload preserved state, continuous follow-ups stayed off, trigger-required hint returned with both switches off; no horizontal overflow or page errors |
| `git diff --check` | Passed |

Browser checks use real configuration handlers, ConfigManager, and isolated disk storage; accounts, model, and device interfaces are fixtures, with no live model/device calls. This is a UI wording change, so no new copy-assertion tests were added. Not run: audible hardware playback, native WebView, long-running use, parent Go checks (shared host unchanged). Remote CI and release are now complete; see below. Initial investigation evidence and the previously published reply remain below.

## Commit, release, and comment (2026-11-09)

After the user explicitly authorized committing, pushing, and replying, source commit [5947732](https://github.com/songloft-org/songloft-plugin-miot/commit/5947732db70ec8caabf8ba70cdb115e8685d247b) was pushed. The [Release Plugin run](https://github.com/songloft-org/songloft-plugin-miot/actions/runs/42625676891) passed for that exact SHA and automatically published [v2026.11.9.1](https://github.com/songloft-org/songloft-plugin-miot/releases/tag/v2026.11.9.1); release metadata commit: `5862dcc`. The downloaded package was checked for its manifest version, `releaseSource`, canonical-content SHA-256 `zipHash` (excluding `plugin.json`, distinct from the ZIP file byte hash), and new UI wording. Evidence: `/tmp/miot137-wording-20261109/package-verification.json` and `ci-complete.log`.

Latest comments were checked before posting. The [reply to songloft-org/songloft-plugin-miot#137](https://github.com/songloft-org/songloft-plugin-miot/issues/137#issuecomment-6741283403) was posted and read back against its draft; evidence: `reply-published.json` in the same directory. The Issue remains open; real speakers and native WebView are not verified. English translation:

> Confirmed: the old label can indeed sound like fallback after a failed song lookup. In practice, enabling it sends speech not recognized as music commands, such as weather questions and casual conversation, to AI without a trigger. Recognized music commands retain priority, and failed playback of recognized song requests does not become chat.
>
> Renamed it to “无需触发词也交给 AI”, moved it from advanced settings next to triggers and continuous follow-ups, and clarified its description. Version v2026.11.9.1 is released; upgrade the Smart Speaker plugin. Existing switch values are preserved.
>
> To enter AI only with “我要你…”, disable both this option (formerly unmatched-music-command fallback) and continuous follow-ups, retain “我要你” as the trigger, and save. Your confirmation that triggers work with fallback disabled identifies this configuration entry.
>
> Source commit: 5947732. All 1,423 local plugin tests, 84 frontend tests, both type checks, build and package validation passed. Desktop/mobile browser checks covered visibility, saving, and reloading. Automated release checks passed. Real speakers and native WebView remain unverified, so the Issue stays open.

## Initial follow-up: findings and field evidence (before confirmation)

The reporter says they upgraded to `v2026.11.9.0` and asked “今天天气怎么样” and “明天会下雨吗”; the plugin interrupted XiaoAI's native responses. The screenshot shows two AI history entries, cancelled at 07:31:29 and completed at 07:39:34, 485 seconds apart. It does not show saved trigger words, follow-up/fallback settings after upgrading, preceding history, or logs. The actual entry path remains unknown.

The local comparison did not reproduce new chat with both switches disabled. Enabling fallback for unmatched music commands makes both questions enter chat. This establishes a possible configuration path, **not evidence that the reporter enabled fallback**. Legacy settings retain their previous follow-up preference; upgrading alone does not disable it. Windows start when answers complete, so history creation timestamps alone cannot exclude that path.

The current voice entry is `src/voicecmd/dispatcher.ts`:

- A trigger at the start of the question submits chat directly.
- Unmatched music commands submit chat only when fallback is enabled, or continuous follow-ups are enabled with a valid window.
- An earlier answer still generating or speaking can be interrupted, but does not independently authorize new chat.

Manual page submission through `/chat/messages` is another entry and does not require voice triggers. The reporter describes voice use; this has not been identified as the cause.

## Versions and validation

Read-only checks on 2026-11-09 found remote main and the local plugin at `a161d3a1d6cc3159219b15f215d0c3f865442c85`; parent repository: `b35fc09e52bf4404ba9dfb1e7e999066ae844b1d`. The initial follow-up changed only investigation and lesson documentation, with no production code or tracked test changes.

The previous fix [0d8f7b7a7ccea8986568817214b98a6f7c2885df](https://github.com/songloft-org/songloft-plugin-miot/commit/0d8f7b7a7ccea8986568817214b98a6f7c2885df) has a successful [Release Plugin run](https://github.com/songloft-org/songloft-plugin-miot/actions/runs/42525964553); the [v2026.11.9.0 release](https://github.com/songloft-org/songloft-plugin-miot/releases/tag/v2026.11.9.0) references that source SHA. This does not verify the reporter's installed package or device behavior.

Environment: Linux x86_64, Node 22.17.1; actual ConfigManager serialization/reads, VoiceDispatcher, MusicCommandService default rules, AIChatService, and PlaybackCoordinator; in-memory storage, simulated models and devices, no live cloud calls. Song memory and AI command analysis were disabled to isolate chat routing; existing regressions additionally cover analysis failures and chat handoff.

| Configuration/state | Result for the two weather questions |
| --- | --- |
| Follow-ups and fallback explicitly disabled | No model requests, new takeovers, or weather chat history |
| Legacy zero window | Same |
| Legacy default/positive window without a previous chat | Same; migration does not create a window |
| Fallback enabled, follow-ups disabled | Two model requests and takeovers; both appear in history |
| Follow-ups only, freshly completed answer | First question enters chat; second after 485 seconds does not |
| Follow-ups only, maximum 300-second window expired | Neither enters chat |
| Previous answer generating/speaking, follow-ups enabled/disabled, fallback disabled | Old answer interrupted; neither question creates a new model request or takeover |

Evidence directory: `/tmp/miot137-followup-20261109/`.

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --test /tmp/miot137-followup-20261109/investigate.test.mjs` | 11 investigation cases pass; `investigate.log`, `outcomes.json` |
| `node --experimental-strip-types --test tests/chat.test.mjs tests/chat_followup.test.mjs tests/chat_scenarios.test.mjs tests/chat_contracts.test.mjs tests/voice_takeover.test.mjs tests/voice_analysis_failure.test.mjs` | 256 regressions pass; `regression.log` |
| `git diff --check` | Passed |

Issue, all three comments, release, and CI snapshots are `issue.json`, `comments.json`, `release.json`, and `ci.json`. Latest screenshot SHA-256: `754dceaa1eb42702f1747e438c52dd26c5303399e5627fabcb31c530dc8ff6e4`.

This is a behavioral investigation with no new fix; passing checks on existing code is not fix acceptance. Not run: real speaker/firmware, audible playback, native WebView, long-running use, or reproduction with field settings; devices/settings are unavailable. Full tests, type checks, build/package validation, browser UI, and parent Go checks were not rerun because production code and UI are unchanged.

## Reply and delivery

Target: `songloft-org/songloft-plugin-miot#137`. On 2026-11-09, after the user authorized replying, all latest comments were rechecked and the Chinese reply was [posted and read back](https://github.com/songloft-org/songloft-plugin-miot/issues/137#issuecomment-6732464560). Its body matches the draft, and the Issue remains open. Evidence: `/tmp/miot137-followup-20261109/reply-published.json`. The English translation follows.

> Thanks for confirming that both questions were still intercepted after upgrading; this is not yet resolved. In a comparison using your exact questions, neither entered AI with continuous follow-ups and unmatched-command fallback disabled. Enabling fallback intercepted both. Your actual entry path remains unknown.
>
> In Settings → AI Settings, disable continuous follow-ups and disable fallback for unmatched music commands under advanced settings. Save, refresh, verify that both remain disabled and the trigger is still “我要你”, then repeat the test. These switches operate independently, and upgrades preserve old settings.
>
> If it still happens, please share the saved switches/trigger after refresh, enable debug logging in Voice Settings, record the reproduction time, and include the surrounding conversation records and corresponding backend logs. Chat history alone cannot identify the entry path. Redact keys, tokens, and other sensitive data before sharing logs. Real-speaker validation has not been performed this round; keep the Issue open.
