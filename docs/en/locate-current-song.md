# Blank current-song location (2026-11-17)

Baseline: `songloft-org/songloft-plugin-miot@6fba93e6f3bdb4e73c00a9a58da67475cd0519d1` plus uncommitted worktree, preserving the preceding cover-recovery changes. This batch changes song-list scroll control only. No commit, push, release or parent gitlink update. Source hashes, commands and logs: `/tmp/songloft-miot-locate/verification.json`.

## Cause and fix

SongList stored the last locate target in `scroll-top`, while gestures only updated the virtual window's start. After locating song 900 and scrolling back to the top, locating it again produced the same property value, so React did not resend it. The virtual window still moved to the target, leaving more than fifty thousand pixels of top spacer at an actual scroll offset of zero. The list appeared blank while the mini player and surrounding page remained functional.

Docker Chromium reproduced the old behavior: the first locate showed the target; the second left scrollTop at zero with the target around y=57832px, still outside the viewport after one second, with no page errors. An isolated dual build of old App succeeds. Serving its Web bundle through test-browser interception makes the new regression time out after three seconds at the second locate's target-visibility assertion. `before-blank.png` matches the report. The user's deployment is unchanged.

`useSongListScroll` now stores each explicit action as a distinct request and invokes `scrollTo` after rows/spacers update. The same destination always executes again. Gestures only update the virtual window, without echoing a controlling property. Playlist/search changes clear stale targets; a reset waits until the loading skeleton becomes a list.

A separate first-locate delay remains when the target is not loaded: pages contain 100 songs and load serially. A fixture executing production store code shows no extra request for a loaded target. With only the first 100 of 1000 songs loaded, finding song 950 or confirming a missing song takes nine more pages; injecting 100ms per page produces about 927ms. Finding song 4950 in 5000 songs takes 49 pages. These measurements exclude real networks/devices/rendering and are not device timing claims. This batch does not change pagination APIs or that loading strategy.

## Verification

The user subsequently authorized this batch's commit, push and parent gitlink synchronization. Actual commits, remote readback and same-SHA workflow status are recorded in `/tmp/songloft-miot-delivery/delivery.json`. The earlier uncommitted status describes initial verification and does not establish Harmony device acceptance.

Environment: Linux x86_64, Node 22.17.1, Docker Chromium 121.0.6167.85. Isolated port 30618 and test SQLite, fixture device/song responses, no real accounts or speakers.

- Four scroll-hook tests pass, covering repeated identical destinations, no gesture-command echo, skeleton readiness, playlist/search resets, mobile/wide row heights and the first-row boundary.
- Frontend types and 128 tests, plugin types and 1499 tests pass. Final Lynx/Web outputs, QuickJS packaging and ZIP validation pass. Logs: `frontend-types.log`, `frontend-tests.log`, `plugin-types.log`, `plugin-tests.log`, `build-final.log`, `validate-final.log`.
- New `frontend/tests/locate.browser.cjs` passes at widths 390/1100. It locates song 900 in a paged 1000-song list, returns to the top, locates again and repeats ten more round-trips. Every locate places the target inside the actual viewport, with no additional page requests after loading and no page errors. DOM existence/selected styling alone is insufficient. Logs: `browser-{390,1100}-final.log`; screenshots: `after-{390,1100}.png`.
- Old-source reversal: `browser-negative.log` times out waiting for target visibility on the second locate. The first isolated build could not resolve plugin-backend source imports; after supplying that directory, both outputs build. That initial build failure is not treated as regression evidence.

Not run: HarmonyOS/Android/iOS device or emulator scrolling, native-shell compilation/device acceptance; no native host source changes. Parent Go/client tests are outside this batch's affected scope. The initial pagination delay and preceding Harmony process crash retain separate open boundaries; this browser result does not establish either as fixed.

[中文](../locate-current-song.md)
