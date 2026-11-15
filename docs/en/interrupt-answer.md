# Interrupting XiaoAI answers

After receiving a conversation webhook, call the dedicated endpoint to stop the answer on the specified speaker:

`POST /api/v1/jsplugin/miot/mina/interrupt`

The endpoint requires a Bearer access token obtained by logging into Songloft. Use the webhook's `account_id` and `device_id` fields; both must be nonempty strings. Include the deployment prefix in the server address when using a subpath.

```bash
curl -X POST 'http://your-Songloft-server:58091/api/v1/jsplugin/miot/mina/interrupt' \
  -H 'Authorization: Bearer <access_token>' \
  -H 'Content-Type: application/json' \
  -d '{"account_id":"account_id from webhook","device_id":"device_id from webhook"}'
```

The endpoint immediately sends one round of `pause → stop`. After that round succeeds, it waits 600ms and sends a second round. It responds after both rounds finish, so request duration includes this settle wait and device requests. The interval was 2000ms; it only needs to cover the time firmware takes to switch into media playback, so it was reduced to 600ms to cut fixed latency from the AI chat path ([Issue #119](https://github.com/songloft-org/songloft-plugin-miot/issues/119)). The second round remains unconditional and is not replaced by a status read-back, because status 0/2 can be misreported ([songloft-org/songloft#449](https://github.com/songloft-org/songloft/issues/449)). Pause is a compatibility step; a rejected pause alone does not prevent the stop attempt.

HD speakers may return a nonzero device stop code even after stopping ([Issue #140](https://github.com/songloft-org/songloft-plugin-miot/issues/140)). Only when the outer cloud request succeeds and the device stop code is nonzero, each round can read at most two fresh statuses, 700ms apart. Both must be explicit non-playing states `0/2/3`. Reads bypass the pre-control cache; a query failure, unknown state, playing state, or failed device status acknowledgment fails the interruption. Cloud failures and request exceptions do not use this fallback. Passing verification in the first round still requires the second stop round; AI feedback or answers wait for both rounds to succeed. New operations can cancel the old task during verification waits or after requests complete. Ordinary stop, pause, and group-member stopping retain their existing error checks.

When both rounds succeed, the response is:

```json
{"success":true,"data":{"message":"interrupt commands accepted","stop_rounds":2,"cancelled":false}}
```

`success: true` means both stop rounds were acknowledged successfully or passed the fresh-status verification above; **this does not prove that the speaker is silent**. This approach follows the L05b report that interrupting the introductory announcement still allowed the story to play, while stopping again after two seconds interrupted it completely ([Issue #118](https://github.com/songloft-org/songloft-plugin-miot/issues/118)). Other models, firmware versions, or later playback stages still require hardware validation.

If a new play, resume, pause, stop, TTS, or interrupt operation for the same account and device enters the device control service during processing, it cancels commands from the old interrupt task that have not yet been sent. Queued commands and retries after token refresh are checked again immediately before sending. The host processes HTTP requests for the same plugin serially, so another HTTP control request normally waits for this endpoint to return; cancellation protects against newer operations that have already entered the service. Cancellation returns the following response; `stop_rounds` counts successful rounds before cancellation, including rounds verified by fresh statuses (0 or 1):

```json
{"success":false,"error":"interrupt superseded by a newer operation","data":{"stop_rounds":1,"cancelled":true}}
```

Requests already sent cannot be recalled. Physical buttons, the XiaoAI app, and other operations outside the plugin cannot be reliably detected and may still be affected by the second stop. Volume changes, status queries, and operations on other accounts or devices do not cancel the interrupt.

An unavailable device or failed stop returns `success: false`, `error: "failed to interrupt"`, and `data.stop_rounds` with `data.cancelled: false`. Missing or invalid IDs return `success: false` with the corresponding field error.

This endpoint only controls the specified speaker. It does not propagate to a device group, modify playlist queues, or take over DLNA playback. Call it while XiaoAI is answering; active playlist automation may push music later, so this endpoint is not a playlist stop command. The existing `/mina/stop` still performs one round, and webhook delivery does not automatically interrupt answers. Scripts using the new endpoint no longer need to schedule their own second stop.

Validation commands: `npx tsc --noEmit` and `node --experimental-strip-types --test tests/*.test.mjs` (Node 22.17 needs TypeScript type stripping for existing tests that import `.ts` files directly). Actual interruption behavior still requires testing on an L05b or another real speaker.
