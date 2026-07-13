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

1. Creates a debug-only `songloft.storage` adapter that records structured error details.
2. Creates and initializes a `MemoryService`.
3. Loads the current memory snapshot.
4. Writes one safe test memory through `recordSuccess()`.
5. Creates a new `MemoryService` and reads the same memory through `findByQuery()`.
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
  "ok": true,
  "step": "done",
  "message": "智能记忆存储自测通过",
  "details": {
    "storage": "songloft.storage",
    "storageKey": "memory:v1:records",
    "normalizedQuery": "smartmemoryruntimeselftest",
    "steps": {
      "load-original": {
        "ok": true,
        "message": "已读取原始记忆快照"
      },
      "init": {
        "ok": true,
        "message": "MemoryService 初始化成功"
      },
      "recordSuccess": {
        "ok": true,
        "message": "recordSuccess 调用成功"
      },
      "write": {
        "ok": true,
        "message": "测试记忆写入成功"
      },
      "read": {
        "ok": true,
        "message": "读取测试记忆成功"
      },
      "recordFailure": {
        "ok": true,
        "message": "recordFailure 调用成功"
      },
      "restore": {
        "ok": true,
        "message": "已恢复自测前的原始记忆快照"
      }
    },
    "foundAfterWrite": {
      "id": "memory_example",
      "type": "play_song",
      "songId": 100000001,
      "songName": "Memory Self Test Song",
      "artist": "Memory Self Test Artist",
      "hitCount": 1,
      "successCount": 1,
      "failureCount": 0
    }
  }
}
```

## Example Failure Response

```json
{
  "ok": false,
  "step": "recordSuccess",
  "message": "写入测试记忆失败",
  "details": {
    "storage": "songloft.storage",
    "storageKey": "memory:v1:records",
    "steps": {
      "recordSuccess": {
        "ok": false,
        "message": "recordSuccess 返回失败",
        "error": {
          "name": "Error",
          "message": "缺少认证信息",
          "stack": [
            "Error: 缺少认证信息"
          ]
        }
      },
      "write": {
        "ok": false,
        "message": "写入测试记忆失败"
      }
    },
    "normalizedQuery": "smartmemoryruntimeselftest"
  }
}
```

## Failure Behavior

All exceptions are caught inside the handler.

If storage fails, the route returns a structured JSON response with:

- `ok`: whether the self-test passed
- `step`: the current failing or completed step
- `message`: a readable Chinese summary
- `details`: step results and structured error details

Storage errors are normalized into:

- `name`
- `message`
- the first 3 stack lines

The self-test is not called from `onInit()` and is only executed when the debug route is requested.
