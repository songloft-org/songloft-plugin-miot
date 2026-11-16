# songloft-jsplugin-miot

A Songloft plugin for sending music to smart speakers through MIoT. [中文](README.md).

“MIoT”, “MiHome” and other protocol/product names belong to their respective trademark owners. Names are used only for interoperability and identification; this plugin has no affiliation, authorization or endorsement from those owners.

## Development

```bash
npm install
npm run dev
npm run build       # dist/miot.jsplugin.zip
npm run validate
```

### Lynx frontend

Following the bili plugin, the frontend uses ReactLynx native elements and `@songloft/lynx-plugin-sdk`. It produces `main.lynx.bundle`, `main.web.bundle` and an automatically generated HTML fallback. Song lists, mini/full players and all six settings categories (devices, playback, voice, AI, schedules and toolbox) are retained.

Domain state uses standalone `@vue/reactivity`, without Vue components or a DOM renderer. HTTP, status/chat sockets, favorite notifications and back navigation use host bridges; frontend code does not read Tokens. The frontend pins published `@songloft/lynx-plugin-sdk@2.21.0`, uses public apiGet/apiPost/apiPut/apiDelete methods and shares PluginSocket for status/chat connections.

Update the matching server and Lynx client together. Older GET/POST-only bridges cannot provide complete editing and live connections; upgrading only the plugin is insufficient. HTML fallback needs server-provided `web-core/`. Static preparation removes legacy Vue output while preserving the builder's generated entry. Icons use inline native SVG to avoid missing fonts in nested frames. Commands, browser scripts and coverage limits are in the [verification record](docs/en/lynx-migration.md).

## Description

This repository provides a smart-speaker integration example and host SDK scaffolding. It does not bundle third-party device protocols or account systems; users are responsible for compliant integration.

## Device groups (multiple rooms)

Controls on any member apply to the other speakers in its group. A group shares one playlist, index, playback mode, transition timer and random sequence.

- Supported operations: playlist playback, pause/resume/stop, previous/next, playback mode, volume and direct URL playback.
- Plugin controls, voice commands and scheduled tasks share the same group behavior. Automatic transitions and resume also use the shared queue.
- One offline/failing member logs a warning without blocking the others. After recovery, the next group command replaces its playback state.
- Each device belongs to at most one group. Moving it removes old membership; removing members or deleting a group restores independent playback.

Open Settings → Devices → Device groups, create a group and select at least two managed speakers. Groups persist across restarts. Cloud commands are independent, so small start-time differences are expected; there is no frame-level synchronization protocol.

## Scheduled tasks and Chinese public holidays

Weekly schedules support three modes:

- Ignore holidays (default): follow selected weekdays.
- Public holidays only: require both an official holiday and a selected weekday.
- Actual working days: skip public holidays and include officially reassigned weekend workdays.

Data comes from MIT-licensed [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn). The `prebuild` hook downloads the current and following year through jsDelivr/GitHub raw and compiles data into the bundle. Runtime access is offline. Before next year's official announcement, empty data means ordinary-day handling, and holiday-only rules do not run. Update regularly for new arrangements. Committed data permits offline builds.

## Releases

The authoritative release workflow and Beijing date/revision numbering are documented in [automatic releases](docs/en/releases.md).

## Registering a search provider

When local library search misses, miot can call configured external sources. Plugins register as candidates; users decide whether to enable them.

1. Implement `POST /api/search/topone` with request `{ keyword, hint?: { title, artist, duration }, quality? }`. Success returns `{ code: 0, msg, data: { title, artist, album?, duration?, cover_url?, url?, plugin_entry_path?, source_data?, dedup_key?, lyric?, lyric_source? } }`; misses/errors use nonzero `code` and `data: null`. Deadline: six seconds. See the API specification dialog in miot settings; ytdlp, bili and subsonic are examples.
2. Declare `inter-plugin` permission and register through `songloft.comm` during `onInit`:

```ts
function registerToMiot() {
  let attempts = 0;
  const tryRegister = async () => {
    attempts++;
    try {
      if (!songloft.comm || typeof songloft.comm.call !== 'function') return;
      await songloft.comm.call('miot', 'register-search-provider', {
        name: 'My source',
        searchPath: '/api/search/topone',
        icon: '',
      });
    } catch (error) {
      if (attempts < 5) setTimeout(tryRegister, 3000);
    }
  };
  setTimeout(tryRegister, 2000);
}
```

Registration is idempotent by trusted caller entry path. Do not send `entryPath`: the host supplies caller identity. `name` defaults to the caller entry path; `searchPath` defaults to `/api/search/topone`; `icon` is optional. Optional `unregister-search-provider` takes an empty payload, typically during `onDeinit`. Delayed retries tolerate startup ordering or absent/older miot installations without blocking initialization.

Registration only adds a candidate. miot verifies installed/active state using the host plugin list, and removed plugins disappear. Built-in ytdlp/bili/subsonic use the same registration while retaining fallback entries for older plugins.

## Author and disclaimer

hanxi. This project is free and intended only for private personal learning and technical research. Commercial use, selling, monetization or distribution for profit is prohibited. Users supply and manage third-party credentials and data, retain ownership, and are responsible for local legal compliance and consequences of misuse. Using the project means accepting these statements.

## License

Apache-2.0 © 2026 hanxi
