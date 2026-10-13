#!/usr/bin/env bun
// mcp-guard: review and pin MCP tool descriptions, summarise the ledger, and audit a setup before
// opening an untrusted repository. It never connects to an MCP server and never calls a model.
//
//   mcp-guard review [--json]                    what the last session saw, against the current pins
//   mcp-guard pin <tool>... | --all-new          pin reviewed tools from that snapshot
//   mcp-guard report [--session <id>] [--json]   per-session summary of the ledger
//   mcp-guard audit --repo <dir> --overlay <file> [--mcp <file>]... [--omp <command>] [--json]
// Common: --config <file> (default ~/.config/omp-mcp-guard/config.json), --snapshot, --pins, --ledger.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfigPath, type GuardSettings, guardSettings, shown } from "../src/config";
import { type LedgerEntry, readLedger } from "../src/ledger";
import { prefixOverlaps, serverPrefix } from "../src/names";
import { canonicalJson, loadPins, type Pins, readSnapshot, type SeenTool, savePins, type ToolState } from "../src/pins";

const USAGE = `usage:
  mcp-guard review [--json]
  mcp-guard pin <tool>... | --all-new
  mcp-guard report [--session <id>] [--json]
  mcp-guard audit --repo <dir> --overlay <file> [--mcp <file>]... [--omp <command>] [--json]
common options: --config <file>, --snapshot <file>, --pins <file>, --ledger <file>`;

/** Files omp 18.2.8 reads project-level MCP servers from (src/discovery). */
export const PROJECT_MCP_FILES = [
	".omp/mcp.json",
	".omp/.mcp.json",
	".mcp.json",
	"mcp.json",
	".claude/mcp.json",
	".claude/.mcp.json",
	".cursor/mcp.json",
	".vscode/mcp.json",
	".windsurf/mcp_config.json",
	".codex/config.toml",
	".gemini/settings.json",
	"opencode.json",
	"opencode.jsonc",
	".opencode/opencode.json",
	".opencode/opencode.jsonc",
];
const PROJECT_SETTINGS_FILES = [".omp/config.yml", ".omp/config.yaml", ".omp/settings.json"];

interface Args {
	command: string;
	positional: string[];
	flags: Map<string, string[]>;
	switches: Set<string>;
}

const VALUE_FLAGS = new Set(["--config", "--snapshot", "--pins", "--ledger", "--session", "--repo", "--overlay", "--mcp", "--omp"]);

function parseArgs(argv: string[]): Args {
	const [command = "", ...rest] = argv;
	const args: Args = { command, positional: [], flags: new Map(), switches: new Set() };
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (VALUE_FLAGS.has(arg)) {
			const value = rest[++i];
			if (value === undefined) fail(`${arg} needs a value`);
			args.flags.set(arg, [...(args.flags.get(arg) ?? []), value]);
		} else if (arg.startsWith("--")) {
			args.switches.add(arg);
		} else {
			args.positional.push(arg);
		}
	}
	return args;
}

function flag(args: Args, name: string): string | undefined {
	return args.flags.get(name)?.at(-1);
}

function fail(message: string, code = 2): never {
	process.stderr.write(`mcp-guard: ${message}\n`);
	process.exit(code);
}

function load(args: Args): GuardSettings {
	const { settings, error } = guardSettings({ configPath: flag(args, "--config") ?? defaultConfigPath() });
	if (error) fail(`the config could not be used: ${error}`);
	return settings;
}

/** Text a server wrote, made safe for a terminal: no escape sequences, control or bidi characters. */
export function terminalSafe(text: string, max = 2000): string {
	const cleaned = text
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[@-_][^\u0007\u001b]*(\u0007|\u001b\\)?/g, "")
		.replace(/\t/g, "  ")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
	return cleaned.length > max ? `${cleaned.slice(0, max)}… (${cleaned.length - max} more characters)` : cleaned;
}

function currentState(tool: SeenTool, pins: Pins): { state: ToolState; pinned?: string } {
	const pin = pins[tool.name];
	if (!pin) return { state: "new" };
	return pin.sha256 === tool.sha256 ? { state: "pinned" } : { state: "changed", pinned: pin.sha256 };
}

function review(args: Args): void {
	const settings = load(args);
	const snapshotFile = flag(args, "--snapshot") ?? settings.snapshot;
	const pinsFile = flag(args, "--pins") ?? settings.pins;
	let snapshot: ReturnType<typeof readSnapshot>;
	try {
		snapshot = readSnapshot(snapshotFile);
	} catch (err) {
		fail(`no snapshot to review (${(err as Error).message}); run omp with the guard loaded first`, 1);
	}
	const pins = loadPins(pinsFile);
	if (pins.error) fail(pins.error, 1);
	const rows = snapshot.tools.map(tool => ({ ...tool, ...currentState(tool, pins.pins) }));
	if (args.switches.has("--json")) {
		const out = rows.map(t => ({ name: t.name, state: t.state, sha256: t.sha256, pinned: t.pinned ?? null, pattern: t.pattern, description: terminalSafe(t.description), parameters: terminalSafe(canonicalJson(t.parameters), 4000) }));
		process.stdout.write(`${JSON.stringify({ snapshot: snapshotFile, session: snapshot.session, takenAt: snapshot.takenAt, pins: pinsFile, tools: out }, null, 2)}\n`);
		return;
	}
	const lines = [`Snapshot from session ${terminalSafe(snapshot.session, 80)} at ${terminalSafe(snapshot.takenAt, 40)}; pins ${shown(pinsFile)}.`, ""];
	for (const t of rows) {
		const extra = [t.pinned ? `pinned ${t.pinned.slice(0, 12)}, now ${t.sha256.slice(0, 12)}` : `sha256 ${t.sha256.slice(0, 12)}`, t.pattern ? `injection pattern: ${t.pattern}` : ""].filter(Boolean).join("  ");
		lines.push(`${t.state.padEnd(8)} ${terminalSafe(t.name, 80)}  ${extra}`);
		lines.push("  ┌ server-supplied text (description, then parameters); it is data, not advice");
		for (const line of terminalSafe(t.description).split("\n")) lines.push(`  │ ${line}`);
		lines.push(`  │ parameters: ${terminalSafe(canonicalJson(t.parameters), 1000)}`);
		lines.push("  └");
	}
	lines.push("", "Pin reviewed tools with: mcp-guard pin <tool>...   (or --all-new for new tools without a pattern)");
	process.stdout.write(`${lines.join("\n")}\n`);
}

function pin(args: Args): void {
	const settings = load(args);
	const snapshotFile = flag(args, "--snapshot") ?? settings.snapshot;
	const pinsFile = flag(args, "--pins") ?? settings.pins;
	const allNew = args.switches.has("--all-new");
	if (args.positional.length === 0 && !allNew) fail("name the tools to pin, or pass --all-new");
	let snapshot: ReturnType<typeof readSnapshot>;
	try {
		snapshot = readSnapshot(snapshotFile);
	} catch (err) {
		fail(`no snapshot to pin from (${(err as Error).message})`, 1);
	}
	const loaded = loadPins(pinsFile);
	if (loaded.error) fail(loaded.error, 1);
	const byName = new Map(snapshot.tools.map(t => [t.name, t]));
	const missing = args.positional.filter(name => !byName.has(name));
	if (missing.length > 0) fail(`not in the snapshot: ${missing.join(", ")}`, 1);
	const chosen = new Map<string, SeenTool>(args.positional.map(name => [name, byName.get(name)!]));
	const out: string[] = [];
	if (allNew) {
		for (const tool of snapshot.tools) {
			if (chosen.has(tool.name)) continue;
			const { state } = currentState(tool, loaded.pins);
			if (state === "pinned") continue;
			if (state === "changed") out.push(`skipped ${tool.name} (changed since its pin; name it to pin it again)`);
			else if (tool.pattern) out.push(`skipped ${tool.name} (injection pattern ${tool.pattern}; name it to pin it anyway)`);
			else chosen.set(tool.name, tool);
		}
	}
	const pins: Pins = { ...loaded.pins };
	const now = new Date().toISOString();
	for (const [name, tool] of chosen) {
		pins[name] = { sha256: tool.sha256, pinnedAt: now };
		out.unshift(`pinned ${name} ${tool.sha256.slice(0, 12)}`);
	}
	if (chosen.size > 0) savePins(pinsFile, pins);
	process.stdout.write(`${out.join("\n")}${out.length > 0 ? "\n" : ""}${chosen.size} tool(s) pinned in ${shown(pinsFile)}.\n`);
}

interface SessionReport {
	session: string;
	startedAt: string | null;
	projectMcp: unknown;
	config: unknown;
	pins: unknown;
	descriptions: { pinned: number; new: number; changed: number; poisoned: number };
	calls: { allow: number; block: number; blocked: Array<{ tool: unknown; reason: unknown; via?: unknown }> };
	results: { pass: number; label: number; withhold: number; withheld: Array<{ server: unknown; tool: unknown; reason: unknown }> };
	instructionsDropped: number;
	listChanged: unknown[];
	collisions: Array<{ tool: unknown; keptServer: unknown; ignoredServer: unknown }>;
	loadFailures: unknown[];
}

export function summarise(entries: LedgerEntry[]): SessionReport[] {
	const sessions = new Map<string, SessionReport>();
	/** Per session, each tool's latest inventory line: tools are re-inventoried when they connect late or change. */
	const latest = new Map<string, Map<string, { state: unknown; pattern: unknown }>>();
	const get = (id: string, ts: unknown) => {
		let s = sessions.get(id);
		if (!s) {
			s = {
				session: id,
				startedAt: typeof ts === "number" ? new Date(ts).toISOString() : null,
				projectMcp: null,
				config: null,
				pins: null,
				descriptions: { pinned: 0, new: 0, changed: 0, poisoned: 0 },
				calls: { allow: 0, block: 0, blocked: [] },
				results: { pass: 0, label: 0, withhold: 0, withheld: [] },
				instructionsDropped: 0,
				listChanged: [],
				collisions: [],
				loadFailures: [],
			};
			sessions.set(id, s);
		}
		return s;
	};
	for (const e of entries) {
		const s = get(String(e.session ?? "unknown"), e.ts);
		switch (e.event) {
			case "session":
				Object.assign(s, { projectMcp: e.projectMcp ?? null, config: e.config ?? null, pins: e.pins ?? null });
				break;
			case "inventory": {
				const tools = latest.get(s.session) ?? new Map<string, { state: unknown; pattern: unknown }>();
				tools.set(String(e.tool), { state: e.state, pattern: e.pattern });
				latest.set(s.session, tools);
				break;
			}
			case "call":
				if (e.decision === "allow") s.calls.allow++;
				else if (e.decision === "block") {
					s.calls.block++;
					if (s.calls.blocked.length < 50) s.calls.blocked.push({ tool: e.tool, reason: e.reason, ...(e.via && e.via !== "direct" ? { via: e.via } : {}) });
				}
				break;
			case "decision":
				if (e.decision === "pass" || e.decision === "label" || e.decision === "withhold") s.results[e.decision]++;
				if (e.decision === "withhold" && s.results.withheld.length < 50) s.results.withheld.push({ server: e.server, tool: e.tool, reason: e.reason });
				break;
			case "instructions":
				s.instructionsDropped++;
				break;
			case "list-changed":
				s.listChanged.push(e.server);
				break;
			case "collision":
				s.collisions.push({ tool: e.tool, keptServer: e.keptServer, ignoredServer: e.ignoredServer });
				break;
			case "load-failed":
				s.loadFailures.push(e.server);
				break;
		}
	}
	for (const s of sessions.values()) {
		for (const t of latest.get(s.session)?.values() ?? []) {
			if (t.state === "pinned" || t.state === "new" || t.state === "changed") s.descriptions[t.state]++;
			if (t.pattern) s.descriptions.poisoned++;
		}
	}
	return [...sessions.values()];
}

function report(args: Args): void {
	const settings = load(args);
	const file = flag(args, "--ledger") ?? settings.ledger;
	let entries: LedgerEntry[];
	try {
		entries = readLedger(file);
	} catch (err) {
		fail(`cannot read the ledger (${(err as Error).message})`, 1);
	}
	const only = flag(args, "--session");
	const sessions = summarise(entries).filter(s => only === undefined || s.session === only);
	if (args.switches.has("--json")) {
		process.stdout.write(`${JSON.stringify({ ledger: file, sessions }, null, 2)}\n`);
		return;
	}
	const lines = [`Ledger ${shown(file)}: ${sessions.length} session(s).`];
	for (const s of sessions) {
		const d = s.descriptions;
		lines.push(
			"",
			`session ${s.session} (${s.startedAt ?? "?"}), project MCP ${String(s.projectMcp)}, config ${String(s.config)}, pins ${String(s.pins)}`,
			`  descriptions: ${d.pinned} pinned, ${d.new} new, ${d.changed} changed, ${d.poisoned} with an injection pattern`,
			`  calls: ${s.calls.allow} allowed, ${s.calls.block} blocked${s.calls.blocked.length > 0 ? ` (${s.calls.blocked.map(b => `${b.tool}: ${b.reason}`).join("; ")})` : ""}`,
			`  results: ${s.results.pass} passed, ${s.results.label} labelled, ${s.results.withhold} withheld${s.results.withheld.length > 0 ? ` (${s.results.withheld.map(w => `${w.tool} from ${w.server}: ${w.reason}`).join("; ")})` : ""}`,
		);
		if (s.instructionsDropped > 0) lines.push(`  server instructions dropped from ${s.instructionsDropped} request(s)`);
		if (s.listChanged.length > 0) lines.push(`  tools/list_changed from: ${s.listChanged.join(", ")}`);
		for (const c of s.collisions) lines.push(`  name collision on ${c.tool}: kept ${c.keptServer}, ignored ${c.ignoredServer}`);
		if (s.loadFailures.length > 0) lines.push(`  failed to load: ${s.loadFailures.join(", ")}`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

interface Check {
	id: string;
	ok: boolean;
	detail: string;
	value?: unknown;
}

function readServers(file: string): { servers: string[]; disabled: string[]; withoutInstructionsOff: string[] } {
	const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, { instructions?: unknown }>; disabledServers?: unknown };
	const disabled = Array.isArray(raw.disabledServers) ? raw.disabledServers.filter((s): s is string => typeof s === "string") : [];
	const entries = Object.entries(raw.mcpServers ?? {}).filter(([name]) => !disabled.includes(name));
	return { servers: entries.map(([name]) => name), disabled, withoutInstructionsOff: entries.filter(([, s]) => s?.instructions !== false).map(([name]) => name) };
}

function audit(args: Args): void {
	const repo = flag(args, "--repo");
	const overlay = flag(args, "--overlay");
	if (!repo || !overlay) fail("audit needs --repo <dir> and --overlay <file>");
	const repoDir = path.resolve(repo);
	const overlayFile = path.resolve(overlay);
	const checks: Check[] = [];
	const notes: string[] = [];

	const { settings, error } = guardSettings({ configPath: flag(args, "--config") ?? defaultConfigPath() });
	checks.push({ id: "guard-config", ok: !error, detail: error ? `the guard's config cannot be used: ${error}` : "the guard's config is valid" });

	let overlayData: unknown;
	try {
		overlayData = Bun.YAML.parse(fs.readFileSync(overlayFile, "utf8"));
	} catch (err) {
		overlayData = null;
		notes.push(`overlay could not be parsed: ${(err as Error).message}`);
	}
	const data = (overlayData && typeof overlayData === "object" ? overlayData : {}) as Record<string, unknown>;
	const nested = (data.mcp as Record<string, unknown> | undefined)?.enableProjectConfig;
	const flat = Object.hasOwn(data, "mcp.enableProjectConfig");
	checks.push({
		id: "overlay-shape",
		ok: nested === false,
		detail:
			nested === false
				? "the overlay sets mcp: enableProjectConfig: false (nested)"
				: flat
					? "the overlay uses the flat key mcp.enableProjectConfig, which omp ignores; nest it under mcp:"
					: "the overlay does not set mcp: enableProjectConfig: false",
	});

	const command = (flag(args, "--omp") ?? "omp").split(/\s+/).filter(Boolean);
	let effective: unknown;
	let effectiveDetail: string;
	try {
		const ran = Bun.spawnSync([...command, "config", "get", "mcp.enableProjectConfig", "--json"], {
			cwd: repoDir,
			env: { ...process.env, PI_CONFIG_FILES: overlayFile },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 120_000,
		});
		const out = ran.stdout.toString();
		effective = (JSON.parse(out.slice(out.indexOf("{"))) as { value?: unknown }).value;
		effectiveDetail = `omp resolves mcp.enableProjectConfig to ${JSON.stringify(effective)} in ${repoDir} with this overlay`;
	} catch (err) {
		effective = undefined;
		effectiveDetail = `could not ask omp (${command.join(" ")}): ${(err as Error).message}`;
	}
	checks.push({ id: "effective-project-config", ok: effective === false, detail: effectiveDetail, value: effective });

	const mcpFiles = args.flags.get("--mcp") ?? [path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent"), "mcp.json")].filter(f => fs.existsSync(f));
	const servers: string[] = [];
	for (const file of mcpFiles) {
		try {
			const r = readServers(file);
			servers.push(...r.servers);
			if (r.withoutInstructionsOff.length > 0) notes.push(`${shown(file)}: ${r.withoutInstructionsOff.join(", ")} without instructions: false (honoured from omp 18.3.1; on 18.2.8 the guard's filter drops them)`);
		} catch (err) {
			checks.push({ id: "server-names", ok: false, detail: `${shown(file)} could not be read: ${(err as Error).message}` });
		}
	}
	const overlaps = prefixOverlaps(servers);
	if (!checks.some(c => c.id === "server-names")) {
		checks.push({
			id: "server-names",
			ok: overlaps.length === 0,
			detail:
				overlaps.length === 0
					? `${servers.length} server name(s), none sharing a tool-name prefix`
					: overlaps.map(o => (o.kind === "same" ? `${o.a} and ${o.b} mint the same tool names (omp keeps one)` : `${serverPrefix(o.a)} (${o.a}) also starts the tools of ${o.b}`)).join("; "),
			value: overlaps,
		});
	}
	if (!error) {
		const conflicts = [...settings.blockedServers].flatMap(b => [...settings.trustedServers].filter(t => serverPrefix(t).startsWith(serverPrefix(b))).map(t => `blocking ${b} also blocks calls to trusted ${t}`));
		checks.push({ id: "guard-lists", ok: conflicts.length === 0, detail: conflicts.length === 0 ? "no blocked server's prefix covers a trusted server" : conflicts.join("; ") });
	}

	const projectMcpFiles = PROJECT_MCP_FILES.filter(f => fs.existsSync(path.join(repoDir, f)));
	const projectSettingsTurningOn = PROJECT_SETTINGS_FILES.filter(f => {
		try {
			return /enableProjectConfig["']?\s*:\s*true\b/.test(fs.readFileSync(path.join(repoDir, f), "utf8"));
		} catch {
			return false;
		}
	});
	const ok = checks.every(c => c.ok);
	if (args.switches.has("--json")) {
		process.stdout.write(`${JSON.stringify({ repo: repoDir, overlay: overlayFile, ok, checks, projectMcpFiles, projectSettingsTurningOn, notes }, null, 2)}\n`);
	} else {
		const lines = [`audit of ${repoDir} with overlay ${shown(overlayFile)}`];
		for (const c of checks) lines.push(`${c.ok ? "pass" : "FAIL"}  ${c.id}: ${c.detail}`);
		lines.push(`project MCP files the overlay keeps omp from loading: ${projectMcpFiles.length > 0 ? projectMcpFiles.join(", ") : "none"}`);
		if (projectSettingsTurningOn.length > 0) lines.push(`project settings that turn project MCP on (the overlay outranks them): ${projectSettingsTurningOn.join(", ")}`);
		for (const n of notes) lines.push(`note: ${n}`);
		process.stdout.write(`${lines.join("\n")}\n`);
	}
	process.exit(ok ? 0 : 1);
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	switch (args.command) {
		case "review":
			review(args);
			break;
		case "pin":
			pin(args);
			break;
		case "report":
			report(args);
			break;
		case "audit":
			audit(args);
			break;
		default:
			fail(USAGE);
	}
}
