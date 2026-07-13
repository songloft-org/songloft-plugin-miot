# Storage Decision for Smart Memory V1

## Decision

Smart Memory V1.0 will use the existing `songloft.storage` API for plugin-local persistence.

The persistent storage probe is removed from startup, and the plugin will not request or add any `persistent-storage` permission for V1.0.

## Evidence

- The Songloft SDK type definitions expose `songloft.persistentStorage` with `get()`, `set()`, `delete()`, and `keys()`.
- The current MIoT plugin manifest only declares the existing `storage` permission.
- The current plugin does not declare a `persistent-storage` permission.
- Probe verification result: `persistentStorage` access failed with permission denied in the current runtime environment.

## Rationale

Although the `persistentStorage` API exists in SDK types, the current plugin does not have the runtime permission needed to use it safely. Adding a new permission is outside the V1.0 scope and could affect plugin validation or installation behavior.

The existing `songloft.storage` API is already used by `ConfigManager` for plugin configuration, voice command configuration, account metadata, scheduled tasks, and logs. Using it for the first smart memory version keeps the implementation inside the current permission model and avoids changing `plugin.json`.

## V1.0 Storage Plan

- Store smart memory data with `songloft.storage`.
- Keep the data small and bounded.
- Do not store accounts, tokens, cookies, passwords, API keys, or raw user-private data.
- Ensure storage failures never block plugin startup or the existing voice command flow.
- Keep fixed control commands before any memory resolution.

## Future Migration

If Songloft officially confirms that `persistent-storage` is available and documents the required manifest permission, a later version can evaluate migration from `songloft.storage` to `songloft.persistentStorage`.

That migration should be explicit, versioned, and backward compatible with existing V1.0 memory records.
