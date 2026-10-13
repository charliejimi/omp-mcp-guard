# omp-mcp-guard

An [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) extension package for MCP tools written by other people, loaded with one `-e`:

- a **call guard** that decides on every MCP call before omp sends it to the server: blocked tools and servers, tools whose description changed since you reviewed it, descriptions that carry an injection pattern, and an allow-list mode for unattended runs;
- a **result guard** that withholds or labels what an MCP server returns, keyed on the exact server that answered (the Day27 article's guard, extended to error and image results);
- an **instructions filter** that removes the servers' `initialize` instructions from omp 18.2.8's system prompt;
- one ledger, and a `mcp-guard` command to review and pin descriptions, summarise sessions, and audit a setup before opening a repository you do not trust.

[中文說明](README.zh-TW.md)

> **Not tested with a real model.** The live tests run real omp (18.2.8, and 18.10.3) end to end with a scripted test model against local MCP servers. They show what is blocked, withheld, labelled, and dropped; they do not show how a real model reacts to that.

## Why

When a repository ships an MCP configuration and omp runs headless, nobody watches what the servers do. The Day27 article measured omp 18.2.8:

- a repository's `.cursor/mcp.json` starts its command before the first model request, unless an overlay sets `mcp.enableProjectConfig: false`, and the repository's own `.omp/config.yml` outranks your global setting;
- omp declares every MCP tool `write`, and the default mode runs it without asking; a headless run cannot answer `always-ask`;
- tool descriptions and server instructions reach the model as written (the instructions in the system prompt), and a `tools/list_changed` notification makes omp rebind changed descriptions without asking again;
- two servers whose names sanitize alike mint one tool name; omp keeps one and writes the collision only to its process log;
- the article's result guard acts after the server ran, and passes error results unchecked.

The integrated sequence diagram for Day27 combines the article's hardening with upstream omp, scanners, and audit practice. This package is the part of it that runs inside omp, plus the checks around it.

## What it does

| Part | When | What it does |
|---|---|---|
| Call guard | `tool_call` of an `mcp__` tool, of `write xd://mcp__…` (how models reach MCP devices), and of `read xd://mcp__…` (full docs) | Blocks before the server runs, first match wins: config unusable; pins unreadable; omp's effective `mcp.enableProjectConfig` not `false`; `blockedTools`; the tool-name prefix of a `blockedServers` entry; a name omp's process log reports as collided; a name omp does not list; a description or schema that changed since its pin; an injection pattern in the description or schema; no pin, when `unpinned` is `block`; not on `allowTools`, when `callPolicy` is `allowlist`. A docs read is blocked for the description and block-list reasons only. |
| Description snapshot | `session_start`, then each turn and each MCP call | Fingerprints every MCP tool's name, description, and parameter schema, compares them with your pins, writes a snapshot for `mcp-guard review`, and records hashes of the config and pins files. omp 18.2.8 waits only 250 ms for MCP servers at startup, so tools from servers that connect later are added when they appear. |
| Result guard | `tool_result` of an `mcp__` tool | Keyed on `details.serverName`: no server identity or a blocked server, withheld; an injection pattern from any server, withheld; a trusted server, passed; any other, labelled `[UNTRUSTED MCP RESULT from MCP server …]`. Error results and image-only results are judged too. A withheld result's details are scrubbed, so the raw text stays out of the session file. |
| Instructions filter | `before_agent_start` | Removes the "MCP Server Instructions" section from the system prompt of every request. The tools stay usable. |
| Process log | `session_start` and each MCP call | Reads this process's `omp.<date>.<pid>.log`: name collisions (then blocked) and servers that failed to load go into the ledger and a notice. |
| Notices | `session_start` | What each part covers, the tool counts per state, which tools each blocked server's prefix catches, and every error that makes the guard fail closed. |
| `mcp-guard` | before and after a run | `review`, `pin`, `report`, `audit`; see below. |

A `tools.approval` deny rule in your settings still comes first: omp stops a denied call before any extension sees it.

## Requirements

- omp 18.2.8 (tested end to end). omp 18.10.3 was tested for native `instructions: false` alongside the guard, for device calls, and for reading the effective project setting.
- [Bun](https://bun.sh) 1.3.14 or newer (tested with 1.4.2).

## Install and run

Clone it **outside** every project the agent works on, so the agent cannot change the guard. The extensions need no dependencies at run time; `bun install` is for the tests.

```bash
git clone <this repository> ~/omp-mcp-guard
cd ~/omp-mcp-guard && bun install
```

List only the servers you need in your own `~/.omp/agent/mcp.json` (see `examples/mcp.json`), copy `examples/overlay.yml` somewhere outside the repository you are about to open, and run:

```bash
omp -p --mode json --cwd <untrusted repo> --no-extensions -e ~/omp-mcp-guard \
  --config ~/omp-overlay.yml "<prompt>" > events.jsonl
```

- `-e ~/omp-mcp-guard` loads the three extensions in the package's order.
- `--config` brings in the overlay; omp ranks global < project < `--config` < flags, so the repository cannot turn project MCP back on. Without it the call guard blocks every MCP call and says why; the project's servers would already have started by then.
- `--no-extensions` keeps auto-discovered extensions out. It does not stop a project's `.mcp.json` (upstream #14182), which is why the overlay is still needed. A managed extension such as hol-guard's `~/.omp/agent/extensions/hol-guard.ts` is turned off too; load it with its own `-e`. Running the two together is untested.
- Keep `--mode json` output: a call stopped by a `tools.approval` deny appears only there.

Subagents receive the same `-e` extensions (measured on Day22), so delegated MCP calls are checked too.

### Reviewing and pinning descriptions

1. Run omp once with the guard loaded. Tools without a pin pass and are recorded as new (with `unpinned: "block"`, they are blocked).
2. `bun ~/omp-mcp-guard/bin/mcp-guard.ts review` prints what that session saw: each tool's state, fingerprint, any injection pattern, and its description and schema as delimited server text, with escape sequences and control characters removed.
3. `mcp-guard pin <tool>...` pins the tools you accept. `--all-new` pins every new tool without a pattern and skips changed or flagged ones; those must be named.

From then on a pinned tool whose description or schema changes is blocked until you review and pin it again, including when the server changes it in the middle of a session.

## Configuration

Optional, in `~/.config/omp-mcp-guard/config.json`, read once when omp loads the guard. Nothing is read from environment variables: Bun loads a project's `.env` into omp's environment, so a repository could otherwise name its own server as trusted. See `examples/config.example.json`.

| Setting | Default | Meaning |
|---|---|---|
| `trustedServers` | `[]` | Exact server names (MCP config keys) whose results pass without a label. |
| `blockedServers` | `[]` | Exact server names. Calls are blocked by tool-name prefix (`mcp__docs_` for `docs`, which also starts the tools of `docs-b`); results are withheld. A name cannot be both trusted and blocked. |
| `blockedTools` | `[]` | Exact `mcp__` names, always blocked. |
| `callPolicy` | `"open"` | `"allowlist"`: only `allowTools` pass. |
| `allowTools` | `[]` | Exact `mcp__` names for the allow list. |
| `unpinned` | `"allow"` | `"block"`: a tool without a pin is blocked. Use it for unattended runs. |
| `requireProjectMcpOff` | `true` | Block every MCP call while omp's effective `mcp.enableProjectConfig` is not `false`, or cannot be read. |
| `serverInstructions` | `"drop"` | `"keep"` leaves the instructions section in place. |
| `blockCollided` | `true` | Block names omp's process log reports as collided. |
| `ledger` | `~/.omp/mcp-guard-ledger.jsonl` | Absolute or starting with `~/`. |
| `pins` | `~/.config/omp-mcp-guard/pins.json` | Written by `mcp-guard pin`. |
| `snapshot` | `~/.omp/mcp-guard-seen.json` | Written at each session start; holds the descriptions for review. |
| `logDir` | `~/.omp/logs` | omp's process log folder; `$XDG_STATE_HOME/omp/logs` when that folder exists, as omp does. |

A config file that cannot be used is reported at session start; the call guard then blocks every MCP call, the result guard withholds every MCP result, and the instructions filter keeps dropping the section.

Rules use tool names because that is all omp lists before a call; it is also the key omp's own `tools.approval` uses. After a name collision, both name rules and pins apply to whichever server omp kept, which is why collided names are blocked.

## The ledger

One JSON object per line with `ts`, `event`, and `session`. Names are passed through a filter that keeps only name characters; tool inputs and result text are never written.

| `event` | Written by | Fields |
|---|---|---|
| `session` | call guard | `tools`, `config` and `pins` (first 12 hex of SHA-256), `projectMcp` (`off`/`on`/`unknown`), `callPolicy`, `unpinned`, `configError`, `pinsError` |
| `inventory` | call guard | `tool`, `state` (`pinned`/`new`/`changed`), `pattern`, `sha256` |
| `call` | call guard | `call`, `tool`, `via` (`direct`/`xd`/`docs`), `decision` (`allow`/`block`), `reason`, `server`, `state`, `pattern` |
| `list-changed` | call guard | `server` |
| `collision` / `load-failed` | call guard | `tool`, `keptServer`, `ignoredServer` / `server` |
| `decision` | result guard | `call`, `server`, `tool`, `provider`, `isError`, `decision` (`pass`/`label`/`withhold`), `reason`, `pattern`, `chars`, `images` |
| `instructions` | instructions filter | `decision`, `chars`, `servers` (the `### ` headings found, which a server can forge), `userAppendDropped` |

## The `mcp-guard` command

Run it with `bun ~/omp-mcp-guard/bin/mcp-guard.ts <command>`. It never connects to an MCP server or calls a model. `--config`, `--snapshot`, `--pins`, and `--ledger` override the paths.

| Command | What it does |
|---|---|
| `review [--json]` | The last snapshot against the current pins. |
| `pin <tool>... \| --all-new` | Pins from the snapshot; refuses names it does not hold. |
| `report [--session <id>] [--json]` | Per session: description states, calls allowed and blocked (with reasons), results passed, labelled, and withheld, instruction drops, `list_changed` notices, collisions, load failures. |
| `audit --repo <dir> --overlay <file> [--mcp <file>]... [--omp <command>] [--json]` | Before opening a repository: asks omp for `mcp.enableProjectConfig` in that directory with the overlay (`PI_CONFIG_FILES`), which must be `false`; checks the overlay is nested; checks that no two server names in your `mcp.json` share a tool-name prefix; checks that no blocked server's prefix covers a trusted one; lists the project MCP files the overlay keeps omp from loading and project settings that try to turn it on. Exits 1 when a check fails. |

## Examples

- `examples/overlay.yml`: nested `mcp.enableProjectConfig: false`; `bash` and `eval` denied; one MCP tool denied by name. omp's own settings loader reads it in the tests.
- `examples/mcp.json`: user-level servers with `instructions: false` (honoured from omp 18.3.1) and a `disabledServers` list.
- `examples/config.example.json`: every setting.

Scanners are not part of this package. Run [snyk/agent-scan](https://github.com/snyk/agent-scan) (`--ci`) or [cisco-ai-defense/mcp-scanner](https://github.com/cisco-ai-defense/mcp-scanner) (`--analyzers yara`) on a repository's MCP config before you open it, in a sandbox: both start the servers' commands or connect to their URLs to read the tool list.

## Tests

```bash
bun run test
```

`bun run test` starts Bun with a temporary `HOME` and `TMPDIR`; plain `bun test` refuses to run, because the suite writes ledgers, pins, and omp state under the home directory. The unit tests go through omp's own extension loader and runner and need no network; the `audit` tests run omp's own `config get`.

The live tests run real omp with a scripted test-only model (`test/scripted-provider.ts`), each run in its own temporary home. The user-level MCP servers run over loopback HTTP inside the test process (`test/mcp-http.ts`), so they connect within omp's 250 ms startup window; in headless omp 18.2.8 runs, a server that connected later never became a device the model could call. The repository's own server is a stdio command (`test/mcp-server.ts`), because the question there is whether omp starts it. To run them:

```bash
MCP_GUARD_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
MCP_GUARD_LIVE_OUT=/tmp/mcp-guard-evidence bun run test test/live.test.ts
```

`OMP_BIN=/path/to/omp` runs an installed omp instead. On omp 18.2.8: without the guard, the server's instructions are in the system prompt, an injected result reaches the model, a tool with a poisoned description runs, and without the overlay the repository's server starts. With it: a blocked server's tool and a poisoned tool are blocked through `xd://` and their servers receive no call; a docs read of the poisoned tool is blocked; a `tools.approval` deny still stops its call first; no request carries the instructions; an injected result and an injected error are withheld and the session file holds neither; an unknown server's result is labelled; a description changed between runs, a tool without a pin, and a description changed in the middle of a session are blocked; the allow list holds; without the overlay every call is blocked; a name collision is read from omp's process log and blocked. On omp 18.10.3: native `instructions: false` and the filter together leave no instructions, device calls are checked before and after the server, and the effective project setting is read with and without the overlay.

## To do before a public release

- **Security audit.** Not run. The threat model (OWASP LLM Top 10 and OWASP Agentic, 20 categories) was done before implementation; an independent adversarial review of the code was not.
- **Real-model runs.** Not run.
- **hol-guard and the scanners.** Not run together with this package.
- **First CI run.** The GitHub Actions workflow has not run yet; `bun.lock` was produced offline.
- **Other omp versions.** Tested on 18.2.8 and 18.10.3 only. The instructions filter, the process-log reader, and the settings read follow those versions' wording and APIs.

## Limits

- **A call that passes still runs on the server.** The guard decides whether a call happens and what the model sees afterwards; it cannot undo what the server did, and it does not inspect arguments.
- **Descriptions still reach the model.** With MCP tools mounted as `xd://` devices (omp's default) the system prompt carries a shortened description and `read xd://<tool>` returns the full one; with devices off, the provider's tool list carries it in full. The guard blocks calls to, and full-docs reads of, flagged or changed tools; it does not rewrite what the model is shown.
- **Pins cover metadata, not behaviour.** A server can change what a tool does without changing its description, and the first description you pin is trusted as reviewed.
- **A call can race a rebind.** After `tools/list_changed`, a call made before omp finished rebinding is checked against the old description.
- **Server blocks are by prefix.** Blocking `docs` also blocks a server named `docs-b`; the session notice and `audit` show the overlap.
- **Keyword patterns are a tripwire.** Reworded payloads are only labelled; a result that merely quotes a phrase is withheld whole. The label is advice the model may ignore.
- **Instructions go as a whole section.** On omp 18.2.8 a user `--append-system-prompt` placed after it goes too (the ledger says so); on 18.3.1 and later, `instructions: false` per server is the finer tool.
- **Slow servers can be missing.** omp 18.2.8 waits 250 ms for MCP servers at startup; in the headless test runs a server that connected later never became an `xd://` device for that session. The guard records such tools when they appear, but cannot make omp mount them.
- **Project MCP servers start before any extension runs.** The guard can only block their calls afterwards; the overlay is what keeps them from starting.
- **The agent can edit the guard's files.** Config and pins are read once per omp start and their hashes go into the ledger, but a hijacked agent with a write tool can change them for the next run. Keep them outside every project and consider making them read-only. The ledger is not tamper-evident.
- **Version-specific readers.** The collision reader depends on omp's log wording, the filter on its heading text, and the settings read on its settings object; when the settings read fails, every call is blocked.

## Background

This package implements the omp side of the Day27 integrated sequence diagram (MCP tools written by other people): step ④'s project-MCP check and instructions filter, step ⑤'s pre-call checks, step ⑥'s result guard, step ⑦'s ledger, report, and process-log facts, and step ③'s audit; the description pins close the gap the diagram lists as possible but unwritten. The injection patterns are the Day25 article's plus the shapes Invariant Labs published for MCP tool poisoning. Upstream context: nested overlays ([#14259](https://github.com/can1357/oh-my-pi/pull/14259)), why only `--config` outranks a project ([#13330](https://github.com/can1357/oh-my-pi/issues/13330)), `--no-extensions` and `.mcp.json` ([#14182](https://github.com/can1357/oh-my-pi/issues/14182)), and per-server `instructions: false` (v18.3.1, [#13196](https://github.com/can1357/oh-my-pi/pull/13196)). [hashgraph-online/hol-guard](https://github.com/hashgraph-online/hol-guard) covers a similar `tool_call` slot as a managed extension.

## License

[MIT](LICENSE)
