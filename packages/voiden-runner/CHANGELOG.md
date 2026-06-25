# Changelog

All notable changes to `@voiden/runner` are documented here. This package is
versioned and released independently of the Voiden desktop app.

## v2.1.1 - 2026-06-25

### Fixed
- A 0-byte file left behind by a failed or interrupted plugin runner download is no longer treated as an installed runner — `hasCoreRunner`/`hasCommunityRunner` now check file size, so the loader falls back to the bundled copy (or re-downloads) instead of importing an empty module
- Bundled runner assets (`bundled-runners/**`) are now included in the published npm package — `plugin install`/`plugin update` for bundled core plugins no longer requires a network download on a fresh install

## v2.1.0 - 2026-06-24

First release published under the `@voiden/runner` name and versioned in lockstep with the desktop app (previously `0.1.0-beta.x`).

### Fixed
- Set-cookie capture in runtime variables no longer lags one request behind — `byPath` can now navigate `set-cookie.<name>.value`, duplicate `set-cookie` headers are preserved instead of being collapsed, and variable capture now runs before post-request hooks so scripts see the current response's values
- Restored plugin registry modules (`registryCache.ts`, `updateCheck.ts`) that had gone missing from the package, breaking `plugin list`/`plugin update`
- Dropped a stale `@voiden/core-extensions` build dependency that no longer exists in the reworked plugin architecture
- Fixed `npm publish` metadata so the package publishes correctly under the `@voiden` npm scope
