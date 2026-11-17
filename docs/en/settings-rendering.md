# Settings rendering investigation (2026-11-17)

## Object and scope

Repository `songloft-org/songloft-plugin-miot`, baseline `2b21e3c754e7fdc1ee685e984caae402362ab331` plus the uncommitted working tree. Initial content fingerprints: `/tmp/miot-settings-20261117/verification.json`; description-interaction fingerprints: `verification-description.json`; latest overflow/startup changes: `verification-overflow.json`. Linux amd64, Node 22.17.1, Docker Chromium 121. Business APIs on the local Docker server configured in `.songloft-dev.json` were read only. As requested, `npm run dev` builds, uploads and hot-reloads plugin id=35. No scheduled tasks or speaker playback state were changed; nothing was committed or released.

## Scheduled tasks

The local `/api/schedules` endpoint successfully returns one task. Both the standalone plugin and actual main application embedding display it in ordinary Chromium. This does not establish native behavior.

`ScheduleSettings` exposes the computed `logTimeFormatter`. Before running mounted callbacks, `usePageState` traverses computed bindings, constructing `Intl.DateTimeFormat` even when there are no logs. The old catch block calls the same API again. A native runtime without Intl or its constructor throws again, preventing task loading.

Only the failure fallback changes: supported runtimes keep formatting logs in the configured timezone; unavailable Intl or unsupported timezones produce ISO timestamps explicitly labelled `UTC`. Task storage, scheduling and execution are unchanged.

- `frontend/tests/schedule_settings.test.mjs`: four cases cover absent/partial Intl, unsupported/supported timezones, and invalid dates. Three fail for the intended behavior against isolated baseline source; all pass after the fix.
- `frontend/tests/schedule-settings.browser.cjs`: removes Intl in the actual plugin background Worker, enters task settings through the UI and checks names/counts against the read-only API. It does not print task names or credentials. Replacing the Web bundle with an isolated baseline build times out waiting for tasks; the current dev bundle displays 1/1 local tasks.
- This proves the initialization defect and fix when Intl is missing. The user's client is still unconfirmed; isolated reproduction is not evidence collected on their device.

## Playback settings overlap

The user subsequently identified the upper-right description toggle as making text appear obscured. Narrow layouts previously limited long descriptions to two lines, while the toggle shared the title row with save-mode text and did not clearly indicate that more content existed.

The shared SectionCard now places the action on its own row below the explanation, labelled “展开说明／收起说明” with a directional arrow. The two-line preview explicitly uses an ellipsis and the touch target is 44px high. Expansion reveals the entire explanation and moves the following card down according to content height. Desktop continues to show full descriptions directly. Heading/title rows do not shrink vertically.

`frontend/tests/section-description.browser.cjs` checks read-only pages on the actual Docker server at 320/390/1100px in light/dark themes: six combinations, two playback cards. Mobile expand/collapse, description/control/card boundaries and 44px targets pass. The isolated old bundle fails the below-description action check; this tests the new interaction structure without claiming that the old two-line preview proved pixel overlap. Logs: `description-before-final.log`, `description-after-final.log`; screenshots: Docker `/tmp/miot-section-descriptions/`. The initial desktop assertion incorrectly required a full explanation to exceed two lines, although the text can fit within two. It was corrected to check full display/boundaries and rerun; this was not a product defect.

After this change, frontend types, 116 tests, isolated native/Web bundles, QuickJS compilation and package validation pass (`description-{typecheck,tests,build,validate}.log`). The no-Intl local-task display regression passes again (`description-schedule-regression.log`). The actual main application embedding also passes the same six combinations (`description-nested.log`). The existing dev process automatically uploads the preview; both installed bundles match local output (`dev-installed-description.json`); tasks and speakers are untouched.

## Fitting explanations and cold-start header follow-up

The user found that the URL explanation was already fully visible but still offered “expand”. The previous `description.length > 40` condition counted characters rather than rendered lines. SectionCard now measures an independent full-text node with the same typography and width. That invisible node does not participate in normal flow, hit testing or accessibility. Only natural text taller than the two 18px lines (with 0.5px rounding tolerance) enables folding. Keeping the full measurement separate from the visible preview prevents a clamp from reporting “fits” and toggling back and forth; width/content changes are measured again. Unknown measurements leave the full text readable. An initial direct text-layout-event approach failed the Web folding check and was replaced with the independent layout measurement; it is not recorded as passing.

The home header always renders a 72px playback-status slot, including before device data arrives. This accommodates the longest current label without shrinking the selector when status appears. No device or playback state semantics change.

- Frontend types and 119 tests pass (`overflow-typecheck.log`, `overflow-tests.log`). Three new regressions cover fitting explanations over forty characters, real overflow through expand/collapse/resize, and content replacement. The isolated previous implementation fails the no-redundant-toggle assertion (`overflow-unit-before.log`).
- `section-description.browser.cjs` additionally checks the actual URL explanation, viewport changes, and the original long descriptions in six width/theme combinations. URL text fits at 320/390/1100px and never offers a toggle; long descriptions remain foldable (`overflow-browser.log`).
- `device-header.browser.cjs` holds configuration, device and initial status HTTP responses, using deterministic fixtures only. At 320/390/1100px, the selector stays 164/234/320px wide across empty startup, connecting, paused, playing and unavailable states; the slot stays 72px (`header-after.log`). The previous bundle shrinks the 320px selector from 244px to 203px as status appears (`header-before.log`). No real playback commands are sent.
- The latest build, validation, main-application embedding and installed-bundle checks are recorded as `overflow-build.log`, `overflow-validate.log`, `overflow-nested.log` and `dev-installed-overflow.json`. Backend business code remains unchanged since the 1499-test pass; native UI limitations below still apply.

An Android API 34 emulator boots, but its host process repeatedly exits with code 139 after entering the Lynx app. Native playback/task UI acceptance remains incomplete and is not recorded as passing. Logs are retained as `emulator-*-failed.log`.

## Validation

Evidence directory: `/tmp/miot-settings-20261117/`.

- Frontend type check and 116 tests pass: `frontend-typecheck-final.log`, `frontend-tests-final.log`.
- Plugin type check and 1499 tests pass: `backend-typecheck.log`, `backend-tests.log`.
- Isolated `npm run build` / `npm run validate` pass: `build-final.log`, `validate-final.log`. Dev native/Web bundles, QuickJS compilation, automatic upload and package validation also pass: `dev.log`, `validate.log`; `dev-installed.json` confirms both installed bundles match local dev output.
- Negative checks: `schedule-before-final.log`, `browser-before-final.log`; positive checks: `schedule-after.log`, `browser-after.log`.
- The first isolated baseline frontend build lacked shared backend types/utilities. Copying those sources allowed `baseline-build-fixed.log` to pass. This missing fixture dependency is not counted as a product regression failure.

Not run: Android/iOS/HarmonyOS native UI acceptance, physical speaker audio, remote CI and formal release. Host and backend business code are unchanged, so parent Go checks were not repeated. Web description interactions are verified; native UI acceptance remains incomplete.

## Commits and remote delivery

After user authorization, implementation [`c8fddc8e0bb3e53f100914476c8c810fbe305dad`](https://github.com/songloft-org/songloft-plugin-miot/commit/c8fddc8e0bb3e53f100914476c8c810fbe305dad) was pushed to main. Its [CI](https://github.com/songloft-org/songloft-plugin-miot/actions/runs/44051350630) passed types, backend/frontend tests, build and validation. The existing automatic workflow published [v2026.11.17.1](https://github.com/songloft-org/songloft-plugin-miot/releases/tag/v2026.11.17.1), with version-metadata commit `c61be31177183cefa7118ef49ce65ff14aea48a4`. This section records delivery only and does not create another business release.

The downloaded release ZIP has SHA-256 `a8c9d5c710ff079932819ca992bf9853dd2691a0d5c87b3df291f4192ebf980a`; its `releaseSource` matches the implementation, `renderEngine=lynx`, and version is `2026.11.17.1`. The local dev package is not presented as the release archive. Evidence: `ci-plugin-current.json`, `release.json`, and `released/miot.jsplugin.zip`. The automatic commit changes version/download/hash metadata only; business source matches the verified implementation. The formal package was not manually installed on the user's Docker server, and the existing dev watcher remains active. Native UI and physical speaker acceptance remain Not run.
