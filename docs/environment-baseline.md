# Development Environment Baseline

## Project

Songloft MIoT Plugin Smart Memory Development


## Environment

Platform:

macOS Apple Silicon


Node:

v26.5.0


npm:

11.17.0


Branch:

feature/voice-memory


## Git

Baseline tag:

before-memory-development


## Build Test

Command:

npm run build


Result:

SUCCESS


Generated:

dist/miot.jsplugin.zip


## Validate Test

Command:

npm run validate


Result:

FAILED


Reason:

plugin.json contains empty entryHash and zipHash after source checkout.

Build command can generate hashes, but validate expects release hash fields.

Do not manually modify hash fields during development.


## Current Status

- Source code unchanged
- AGENTS.md added
- Build environment verified
- No business logic modified


## Next Step

Implement persistentStorage probe only.

Goals:

- Verify runtime availability of persistentStorage
- Verify set/get/keys/delete behavior
- Do not modify voice command flow
- Do not implement memory matching yet