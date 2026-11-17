# Transient default covers (2026-11-17)

Baseline: `19751421dc314cb15b2d0b5c5a7019608cc2dc7a` (v2026.11.17.3). The user installs through npm run dev and clarified that the default icon briefly appears even when covers exist, in mini/full players, scrolling and resume. This batch changes neither client containers nor main-list layout. Earlier retention/final-node checks did not cover loading transitions.

## Cause and fix

Cover initialized source as empty, so resolving authorized URLs, remounting recycled rows and recreating mini/full covers all rendered `♫` first. Automatic retries also set failed before replacing that fallback. A correct final image does not establish a fallback-free transition.

Known-cover resolution/retries now differ from genuinely missing or exhausted covers. Loading known covers does not paint a default icon. Successfully loaded addresses are reused in memory and available on the first render of a remount. Cache identity includes server, song, raw URL version and dimensions, bounded to 256 entries and 8192 characters per address. Failures invalidate entries; another song cannot inherit the previous image. Inline data URLs paint directly without retaining additional Base64 entries. Genuine missing covers use the existing inline SVG note with matching theme color/size, eliminating font-glyph dependence. Permanent failures retain fallback and later recovery.

## Evidence

Linux x86_64, Node 22.17.1, Docker Chromium 121.0.6167.85; isolated SQLite/port 30618 with device/image HTTP fixtures. Hashes, commands, results and delivery: `/tmp/songloft-cover-placeholder/verification.json`, `delivery.json`.

- Nine of nineteen cover tests fail behaviorally with isolated old source; all nineteen pass after the fix. Coverage includes first render, recycled remounts, SVG, transient retries, stale-image isolation, size/version/server scope and failed-cache invalidation.
- New `frontend/tests/cover_loading.browser.cjs` observes **temporary false-fallback additions**, including first full-player entry, mini return, settings, a 100-row scroll round-trip, one image failure/retry and five hide/resume cycles. The old package produces 64 additions: ambient 2, full 1, mini 2, list 59, despite correct final images; the regression fails. These are DOM additions, not a claim about visible frame count.
- The final package produces zero false defaults at widths 390/1100. Actual missing covers use SVG, with no page errors. Existing local/data/signed URL, bounded-404 recovery, actual decoding, list/mini/full geometry and six-round internal navigation regressions also pass. Logs: `browser-before.log`, `browser-final-{390,1100}.log`, `browser-general.log`, `browser-navigation.log`.
- Frontend types, 137 frontend tests, plugin types/1499 tests, Lynx/Web bundles, QuickJS and ZIP validation pass: `types-final.log`, `frontend-tests-final.log`, `plugin-{types,tests}.log`, `build-final.log`, `validate-final.log`. Initial SDK extension-property and nullable-song type diagnostics were corrected and rerun successfully.

Not run: HarmonyOS/Android/iOS device compositing, real background process reclamation, keyboards and speakers. Browser hiding/resume only simulates protocol/page transitions. No native host changes or HAP/APK/Apple rebuild. Zero browser false-fallback additions do not establish acceptance of every Harmony drawing flash. Delivery follows this conversation's existing commit/push authorization, without Issue writes or manually creating a stable release.

[中文](../cover-placeholder.md)
