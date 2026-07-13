# Smart Memory V1.0 Skeleton

## Current Scope

This change only adds the Smart Memory V1.0 foundation under `src/memory/`.

It is not connected to `VoiceEngine`, `ConversationMonitor`, HTTP handlers, plugin startup, or any existing voice command path.

## Added Modules

- `src/memory/types.ts`: simplified memory record and storage types.
- `src/memory/storage_adapter.ts`: `songloft.storage` adapter for loading and saving the V1 memory snapshot.
- `src/memory/memory_service.ts`: in-memory cache plus basic `init()`, `load()`, `save()`, `findByQuery()`, `recordSuccess()`, `recordFailure()`, and `normalizeQuery()` methods.
- `src/memory/index.ts`: export surface for later integration.

## Storage Decision

V1.0 uses the existing `songloft.storage` API.

It does not use `songloft.persistentStorage` and does not require any new plugin permission.

The persisted data is stored as one bounded JSON snapshot under:

```text
memory:v1:records
```

## Safety Rules

- No account data is stored.
- No token is stored.
- No cookie is stored.
- No password or API key is stored.
- Raw voice text is not stored; records use normalized query text only.
- Storage failures are caught and return empty or false results.

## Not Implemented Yet

- No call from `src/main.ts`.
- No call from `src/voicecmd/engine.ts`.
- No fixed-control-command split.
- No memory resolve in the voice flow.
- No UI or HTTP route.

## Future Integration

When the voice flow is updated later, memory must be inserted only after fixed control commands and before existing song or playlist matching. Memory failure must continue to fall back to the existing voice command flow.
