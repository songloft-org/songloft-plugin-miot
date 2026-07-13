# Smart Memory Runtime Self-Test

## Purpose

This runtime self-test verifies that Smart Memory V1.0 can read and write memory data through the existing `songloft.storage` backend.

It does not connect Smart Memory to `VoiceEngine`, does not change AI analysis, and does not change the current voice command flow.

## Route

```text
GET /memory/self-test
```

## How To Access

After the plugin is running in Songloft, open the plugin HTTP route in the Songloft page or a browser:

```text
http://<plugin-host>/memory/self-test
```

Use the same host and port that Songloft exposes for other plugin routes such as `/config`, `/conversation/status`, or `/indexing/status`.

## What The Test Does

The handler performs these steps:

1. Creates a `SongloftStorageMemoryAdapter`.
2. Creates and initializes a `MemoryService`.
3. Loads the current memory snapshot.
4. Writes one safe test memory through `recordSuccess()`.
5. Reads the same memory through `findByQuery()`.
6. Calls `recordFailure()` once for the same query.
7. Attempts to restore the original memory snapshot.
8. Returns a JSON result.

## Test Data Safety

The test data contains only:

- a fixed test query
- a fake song id
- a fake song name
- a fake artist name
- a fake song index

It does not store accounts, tokens, cookies, passwords, API keys, or real user data.

## Example Success Response

```json
{
  "success": true,
  "data": {
    "storage": "songloft.storage",
    "initialized": true,
    "normalizedQuery": "smartmemoryruntimeselftest",
    "write": {
      "success": true,
      "found": true
    },
    "recordSuccess": {
      "success": true
    },
    "recordFailure": {
      "success": true,
      "found": true
    },
    "restore": {
      "attempted": true,
      "success": true
    }
  }
}
```

## Failure Behavior

All exceptions are caught inside the handler.

If storage fails, the route returns a JSON error response and plugin startup is not affected.

The self-test is not called from `onInit()` and is only executed when the debug route is requested.
