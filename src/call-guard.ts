// omp-mcp-guard, call guard: decides on every MCP tool call before omp sends `tools/call`, so a
// blocked call never reaches the server. omp declares every MCP tool `write`, and in the default
// `yolo` mode, and in any headless run, nothing asks a person first.
//
// The model reaches an MCP tool directly (`mcp__<server>_<tool>`) or as a device (`write
// xd://mcp__…`). For a device call omp emits `tool_call` twice: for the outer `write` and, from
// the wrapper of the nested dispatch, for the inner `mcp__` tool under its canonical name. The inner
// event is the one that counts; the outer one is judged too when it names a registered tool.
//
// Before a call omp lists MCP tools by name only (`getAllTools()`); the raw server name is known
// after the call. So rules here use tool names, as omp's own `tools.approval` does, and a blocked
// server is matched by its tool-name prefix, which fails closed: blocking `docs` also blocks a
// server named `docs-b`.
//
// Decision order, first match wins: config unusable; pins unreadable; project MCP not off;
// blockedTools; blocked server prefix; collided name (omp's process log); unknown name;
// description changed since its pin; injection pattern in the description or schema; unpinned
// (when `unpinned: "block"`); not on allowTools (when `callPolicy: "allowlist"`).
//
// It does not inspect arguments, and the descriptions still reach the model in the tool list.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type GuardOptions, guardSettings, shown } from "./config";
import { openLedger, sessionOf } from "./ledger";
import { isMcpToolName, type McpResourceRef, mcpResource, safeName, serverPrefix, xdTarget } from "./names";
import { classifyOne, loadPins, type ToolLike, writePrivateJson } from "./pins";
import { type Collision, logSignature, readProcessLog } from "./proclog";

export interface CallGuardOptions extends Omit<GuardOptions, "logDir"> {
	/** Where omp writes its process log; `null` reads none. */
	logDir?: string | null;
	/** omp's effective `mcp.enableProjectConfig`. Defaults to omp's settings, read through the extension API. */
	projectMcpEnabled?: () => unknown;
	/** The process whose log to read. Defaults to this one, which is omp's. */
	pid?: number;
}

type ProjectMcp = "off" | "on" | "unknown";
type Via = "direct" | "xd" | "docs" | "resource";

interface Verdict {
	decision: "allow" | "block";
	reason: string | null;
	text: string;
	fields: Record<string, unknown>;
}

const LIST_CHANGED = "notifications/tools/list_changed";
/** Reasons that also block reading the tool's full docs through `read xd://`. */
const DOCS_REASONS = new Set(["config-error", "pins-error", "blocked-tool", "blocked-server", "changed", "poisoned-description"]);

/**
 * omp's effective `mcp.enableProjectConfig` from its settings object: `get(key)` in 18.2.8;
 * `rawValue(handle)` in 18.10.x, which reads a handle's `segments` and returns undefined when the
 * setting is unset (omp's default is true). Anything else yields undefined, and the guard fails closed.
 */
export function effectiveProjectConfig(settings: unknown): unknown {
	const s = settings as { get?: unknown; rawValue?: unknown } | null | undefined;
	if (typeof s?.get === "function") return (s.get as (key: string) => unknown).call(s, "mcp.enableProjectConfig");
	if (typeof s?.rawValue === "function") {
		const value = (s.rawValue as (handle: unknown) => unknown).call(s, { id: "mcp.enableProjectConfig", segments: ["mcp", "enableProjectConfig"], definition: {} });
		return value === undefined ? true : value;
	}
	return undefined;
}

function settingsReader(pi: ExtensionAPI): () => unknown {
	return () => effectiveProjectConfig((pi as unknown as { pi?: { settings?: unknown } }).pi?.settings);
}

function short(hash: string | undefined): string {
	return (hash ?? "").slice(0, 12);
}

export function createMcpCallGuard(options: CallGuardOptions = {}) {
	return function mcpCallGuard(pi: ExtensionAPI): void {
		const { projectMcpEnabled, pid = process.pid, logDir: logDirOption, ...rest } = options;
		const { settings, error, configSha256 } = guardSettings(logDirOption === null ? rest : { ...rest, logDir: logDirOption });
		const logDir = logDirOption === null ? null : settings.logDir;
		const ledger = openLedger(settings.ledger);
		const pins = loadPins(settings.pins);
		const readProject = projectMcpEnabled ?? settingsReader(pi);
		const collided = new Map<string, Collision>();
		const failed = new Set<string>();
		let projectMcp: ProjectMcp | undefined;
		let logSeen: string | undefined;

		const mcpTools = (): ToolLike[] => {
			try {
				return (pi.getAllTools() as ToolLike[]).filter(tool => isMcpToolName(tool.name));
			} catch {
				return [];
			}
		};
		const currentTool = (name: string) => mcpTools().find(tool => tool.name === name);

		const readProjectMcp = (): ProjectMcp => {
			try {
				const value = readProject();
				return value === false ? "off" : value === true ? "on" : "unknown";
			} catch {
				return "unknown";
			}
		};

		/** New collisions and load failures from omp's process log, recorded once each. */
		const readLog = (session: string): { collisions: Collision[]; failures: string[] } => {
			const fresh = { collisions: [] as Collision[], failures: [] as string[] };
			if (logDir === null) return fresh;
			const signature = logSignature(logDir, pid);
			if (signature === logSeen) return fresh;
			logSeen = signature;
			const facts = readProcessLog(logDir, pid);
			for (const c of facts.collisions) {
				if (collided.has(c.name)) continue;
				collided.set(c.name, c);
				fresh.collisions.push(c);
				ledger.append({ event: "collision", session, tool: safeName(c.name), keptServer: safeName(c.keptServer), ignoredServer: safeName(c.ignoredServer) });
			}
			for (const f of facts.loadFailures) {
				if (failed.has(f.server)) continue;
				failed.add(f.server);
				fresh.failures.push(f.server);
				ledger.append({ event: "load-failed", session, server: safeName(f.server) });
			}
			return fresh;
		};

		const block = (reason: string, text: string, fields: Record<string, unknown> = {}): Verdict => ({ decision: "block", reason, text, fields });

		/** The checks that block every MCP call, whatever it names. */
		const precheck = (): Verdict | undefined => {
			if (error) return block("config-error", `the guard's config could not be used (${error}); MCP calls are blocked until it is fixed.`);
			if (pins.error) return block("pins-error", `the pins file could not be read (${pins.error}); MCP calls are blocked until it is fixed.`);
			if (settings.requireProjectMcpOff && projectMcp === "on") {
				return block("project-mcp-on", "omp's effective mcp.enableProjectConfig is true, so the project's own MCP servers may be loaded; MCP calls are blocked. Start omp with an overlay that sets mcp.enableProjectConfig to false.");
			}
			if (settings.requireProjectMcpOff && projectMcp !== "off") return block("project-mcp-unknown", "the guard could not read omp's effective mcp.enableProjectConfig, so MCP calls are blocked.");
			return undefined;
		};

		/**
		 * A `read` of an MCP resource. Before the call omp names no server, so a blocked server is
		 * matched by the resource's scheme, which only catches a server that uses its own name; the
		 * result guard labels or withholds whatever this lets through.
		 */
		const decideResource = (resource: McpResourceRef): Verdict => {
			const early = precheck();
			if (early) return early;
			const server = [...settings.blockedServers].find(name => name.toLowerCase() === resource.scheme);
			if (server !== undefined) return block("blocked-server", `it reads an MCP resource whose scheme names blocked server ${safeName(server)}.`, { server: safeName(server) });
			if (settings.callPolicy === "allowlist") return block("not-allowlisted", "callPolicy is allowlist, and MCP resource reads are not on allowTools.");
			return { decision: "allow", reason: null, text: "", fields: {} };
		};

		const decide = (target: string): Verdict => {
			const early = precheck();
			if (early) return early;
			if (settings.blockedTools.has(target)) return block("blocked-tool", "the tool is on blockedTools.");
			const server = [...settings.blockedServers].find(name => target.startsWith(serverPrefix(name)));
			if (server !== undefined) {
				return block("blocked-server", `its name starts with ${serverPrefix(server)}, the tool-name prefix of blocked server ${safeName(server)}.`, { server: safeName(server) });
			}
			const collision = settings.blockCollided ? collided.get(target) : undefined;
			if (collision) {
				return block(
					"name-collision",
					`two MCP servers registered this name (omp kept ${safeName(collision.keptServer)} and ignored ${safeName(collision.ignoredServer)}), so the guard cannot tell which one would answer.`,
				);
			}
			const tool = currentTool(target);
			if (!tool) return block("unknown-tool", "omp lists no MCP tool by this name.");
			const seen = classifyOne(tool, pins.pins);
			const fields = { state: seen.state, sha256: short(seen.sha256) };
			if (seen.state === "changed") {
				return block(
					"changed",
					`its description or parameters changed since it was pinned (pinned ${short(seen.pinned)}, now ${short(seen.sha256)}). If the change is expected, review it with \`mcp-guard review\` and pin it again.`,
					fields,
				);
			}
			if (seen.pattern) return block("poisoned-description", `its description or parameter schema matches an injection pattern (${seen.pattern}).`, { ...fields, pattern: seen.pattern });
			if (seen.state === "new" && settings.unpinned === "block") {
				return block("unpinned", `it has no pin, and unpinned tools are blocked. Review it with \`mcp-guard review\`, then run \`mcp-guard pin ${target}\`.`, fields);
			}
			if (settings.callPolicy === "allowlist" && !settings.allowTools.has(target)) {
				return block("not-allowlisted", "callPolicy is allowlist and the tool is not on allowTools.", fields);
			}
			return { decision: "allow", reason: null, text: "", fields };
		};

		/** Fingerprints already recorded this session, so tools that connect late are added once. */
		const inventoried = new Map<string, string>();
		const refreshInventory = (session: string, writeAnyway = false) => {
			const seen = mcpTools().map(tool => classifyOne(tool, pins.pins));
			const fresh = seen.filter(t => inventoried.get(t.name) !== t.sha256);
			if (fresh.length === 0 && !writeAnyway) return seen;
			for (const t of fresh) {
				inventoried.set(t.name, t.sha256);
				ledger.append({ event: "inventory", session, tool: safeName(t.name), state: t.state, pattern: t.pattern, sha256: short(t.sha256) });
			}
			try {
				writePrivateJson(settings.snapshot, { version: 1, takenAt: new Date().toISOString(), session, tools: seen });
			} catch {}
			return seen;
		};

		const start = (ctx: unknown) => {
			const session = sessionOf(ctx);
			projectMcp = readProjectMcp();
			const log = readLog(session);
			const tools = mcpTools();
			ledger.append({
				event: "session",
				session,
				tools: tools.length,
				config: configSha256 ? short(configSha256) : null,
				pins: pins.sha256 ? short(pins.sha256) : null,
				projectMcp,
				callPolicy: settings.callPolicy,
				unpinned: settings.unpinned,
				configError: error ?? null,
				pinsError: pins.error ?? null,
			});
			return { seen: refreshInventory(session, true), log };
		};

		pi.on("session_start", (_event, ctx) => {
			let report: ReturnType<typeof start> | undefined;
			try {
				report = start(ctx);
			} catch (err) {
				ledger.append({ event: "guard-error", session: sessionOf(ctx), phase: "session_start", error: String((err as Error)?.message ?? err) });
			}
			if (error) {
				ctx.ui.notify(`omp-mcp-guard: the config could not be used (${error}); every MCP call is blocked until it is fixed.`, "error");
				return;
			}
			if (pins.error) ctx.ui.notify(`omp-mcp-guard: the pins file could not be read (${pins.error}); every MCP call is blocked until it is fixed.`, "error");
			if (settings.requireProjectMcpOff && projectMcp === "on") {
				ctx.ui.notify(
					"omp-mcp-guard: omp's effective mcp.enableProjectConfig is true, so project MCP servers may already have started; every MCP call is blocked. Start omp with an overlay (--config) that sets mcp.enableProjectConfig: false.",
					"error",
				);
			} else if (settings.requireProjectMcpOff && projectMcp !== "off") {
				ctx.ui.notify("omp-mcp-guard: could not read omp's effective mcp.enableProjectConfig; every MCP call is blocked.", "error");
			}
			const seen = report?.seen ?? [];
			const count = (state: string) => seen.filter(t => t.state === state).length;
			const blockedNote = [...settings.blockedServers]
				.map(name => {
					const hit = seen.filter(t => t.name.startsWith(serverPrefix(name))).map(t => t.name);
					return `${safeName(name)} (blocks ${hit.length > 0 ? hit.join(", ") : "no listed tool"})`;
				})
				.join("; ");
			ctx.ui.notify(
				`omp-mcp-guard: call guard on. ${seen.length} MCP tools: ${count("pinned")} pinned, ${count("new")} new, ${count("changed")} changed, ${seen.filter(t => t.pattern).length} with an injection pattern in the description. Policy: ${settings.callPolicy}${settings.unpinned === "block" ? ", unpinned tools blocked" : ""}. Blocked servers: ${blockedNote || "none"}. Ledger ${shown(settings.ledger)}; snapshot ${shown(settings.snapshot)} (mcp-guard review).`,
				"info",
			);
			for (const c of report?.log.collisions ?? []) {
				ctx.ui.notify(`omp-mcp-guard: omp's process log reports an MCP tool name collision on ${safeName(c.name)}: it kept ${safeName(c.keptServer)} and ignored ${safeName(c.ignoredServer)}.${settings.blockCollided ? " Calls to it are blocked." : ""}`, "warning");
			}
			for (const server of report?.log.failures ?? []) ctx.ui.notify(`omp-mcp-guard: MCP server ${safeName(server)} failed to load (omp's process log).`, "warning");
		});

		// omp 18.2.8 waits 250 ms for MCP servers at startup and registers slower ones later.
		pi.on("turn_start", (_event, ctx) => {
			try {
				refreshInventory(sessionOf(ctx));
			} catch {}
		});

		pi.on("mcp_notification", (event, ctx) => {
			if (event.method !== LIST_CHANGED) return;
			ledger.append({ event: "list-changed", session: sessionOf(ctx), server: safeName(event.server) });
		});

		pi.on("tool_call", (event, ctx) => {
			const tool = event.toolName;
			let target: string;
			let via: Via;
			const resource = tool === "read" ? mcpResource((event.input as { path?: unknown } | undefined)?.path) : null;
			if (isMcpToolName(tool)) {
				target = tool;
				via = "direct";
			} else if (resource) {
				target = safeName(resource.uri);
				via = "resource";
			} else if (tool === "write" || tool === "read") {
				const name = xdTarget((event.input as { path?: unknown } | undefined)?.path);
				if (!name || !isMcpToolName(name) || !currentTool(name)) return undefined;
				target = name;
				via = tool === "write" ? "xd" : "docs";
			} else {
				return undefined;
			}
			const session = sessionOf(ctx);
			if (projectMcp === undefined) projectMcp = readProjectMcp();
			readLog(session);
			try {
				refreshInventory(session);
			} catch {}
			const verdict = resource ? decideResource(resource) : decide(target);
			const blocks = verdict.decision === "block" && (via !== "docs" || DOCS_REASONS.has(verdict.reason ?? ""));
			const line = { event: "call", session, call: event.toolCallId, tool: safeName(target), via, ...verdict.fields };
			if (!blocks) {
				if (via === "direct" || via === "resource") ledger.append({ ...line, decision: "allow", reason: null });
				return undefined;
			}
			ledger.append({ ...line, decision: "block", reason: verdict.reason });
			return { block: true, reason: `omp-mcp-guard blocked ${target}: ${verdict.text} Do not try to reach this tool another way.` };
		});
	};
}

export default createMcpCallGuard();
