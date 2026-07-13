# Smart Memory Voice Integration

## Scope

This change connects Smart Memory V1.0 to `VoiceEngine.handleMessage()` with a minimal fallback-first path.

It does not change plugin permissions, account authentication, `AIAnalyzer`, or `plugin.json`.

## Runtime Order

The voice runtime order is now:

1. Fixed control command matching
2. Smart memory lookup
3. Existing song or playlist rule matching
4. AI fallback

Fixed control commands are:

- `set_play_mode`
- `set_volume`
- `next`
- `previous`
- `stop`

Smart memory is only checked after those commands fail to match.

The built-in stop aliases `pause`, `stop`, `暂停播放`, `停止播放`, `停一下`, and `暂停音乐` are matched before memory even when an older saved voice-command configuration does not contain them.

## V1 Playback Scope

V1 only executes memory records whose type is `play_song`.

Supported playable memory shapes:

- `playlistId + songIndex`
- `songId` with a playable Songloft song URL

Playlist memory records are deliberately ignored for now and fall back to the existing flow.

## Learning From Successful Playback

When an existing `play_song` rule or the AI fallback successfully starts a song, `VoiceEngine` queues `MemoryService.recordSuccess()` with the original user query and the actual played song metadata.

For songs found in a playlist, the record includes `songName`, `artist`, `songId`, `playlistId`, and `songIndex`. `MemoryService` derives and stores `normalizedQuery`. The storage write runs asynchronously and cannot delay or fail the completed playback.

## Fallback Behavior

Memory lookup and playback are wrapped in `try/catch`.

If memory misses, fails to initialize, or cannot play its hit, `VoiceEngine` continues to the existing song or playlist rule matching and then AI fallback.

Success and failure statistics are recorded asynchronously. A statistics storage error cannot turn a successful memory playback into a fallback execution or delay fallback after a failed playback attempt.

Relevant logs:

```text
[VoiceMemory] hit
[VoiceMemory] miss
[VoiceMemory] error fallback
```

## Quick Rollback

Set this constant in `src/voicecmd/engine.ts` to `false`, then rebuild:

```ts
const VOICE_MEMORY_ENABLED = false;
```

This disables the memory branch while preserving the rest of the voice flow.

## Current Diagnostic Limit

The settings-page command test still uses its existing diagnostic path and does not exercise or display Smart Memory. Runtime verification must use real voice input and the `[VoiceMemory]` logs.
