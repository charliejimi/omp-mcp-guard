# Changelog

## [0.1.0] - 2026-10-13

### Added

- Call guard: decides on every MCP call before omp sends it to the server, for direct `mcp__` calls, `write xd://mcp__…` device calls, and `read xd://mcp__…` docs reads. Blocks on, in order: an unusable config, an unreadable pins file, omp's effective `mcp.enableProjectConfig` not `false`, `blockedTools`, a `blockedServers` tool-name prefix, a name omp's process log reports as collided, a name omp does not list, a description or schema changed since its pin, an injection pattern in the description or schema, a missing pin (`unpinned: "block"`), and a name outside `allowTools` (`callPolicy: "allowlist"`).
- Description pins: a SHA-256 fingerprint of each MCP tool's name, description, and parameter schema, compared with the current tool list before every call, so a change after `tools/list_changed` is caught in the same session. A snapshot of what each session saw is written for review, and refreshed when tools from servers that connected late appear.
- Result guard: the Day27 article's MCP result guard, keyed on `details.serverName`, with a config file instead of environment variables. Error results and image-only results are judged too, and a failure inside the guard withholds the result.
- Instructions filter: removes omp 18.2.8's "MCP Server Instructions" section from the system prompt of every request.
- Process-log reader: name collisions and servers that failed to load, which omp writes only to its process log, go into the ledger and a session notice.
- Session notices and one JSONL ledger without tool inputs or result text, including SHA-256 prefixes of the config and pins files.
- `mcp-guard` command: `review` (snapshot against pins, terminal-safe), `pin` (named tools, or `--all-new` without changed or flagged ones), `report` (per-session summary), `audit` (asks omp for the effective `mcp.enableProjectConfig` with an overlay, checks the overlay's shape, server-name prefixes, and block/trust overlaps, lists project MCP files).
- Examples: a settings overlay, a user-level `mcp.json`, and a config file with every setting.
