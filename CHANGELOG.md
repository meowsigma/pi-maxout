# Changelog

## 1.0.0

- Provider-aware request patching with fail-open behavior for unknown API shapes.
- Per-model session overrides and optional persistent defaults.
- Atomic state writes with invalid-state backup and restrictive permissions.
- Uses Pi's active agent directory instead of assuming a fixed path.
- Reports the exact request field this extension changed.
- Removes the unsafe context-window fallback from `/maxout max`.
- Adds dependency-free tests, TypeScript declarations, and an installer with rollback.
