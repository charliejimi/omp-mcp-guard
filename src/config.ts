// The user's configuration, read from one file, once per session. Nothing here reads trust from
// environment variables: Bun loads a project's .env into omp's environment, so a repository could
// otherwise name its own server as trusted.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isMcpToolName } from "./names";

export type CallPolicy = "open" | "allowlist";
export type UnpinnedPolicy = "allow" | "block";
export type InstructionsPolicy = "drop" | "keep";

export interface McpGuardConfig {
	/** The ledger every part appends to. Default `~/.omp/mcp-guard-ledger.jsonl`. */
	ledger?: string;
	/** Reviewed description fingerprints. Default `~/.config/omp-mcp-guard/pins.json`. */
	pins?: string;
	/** What the last session saw, for `mcp-guard review` and `pin`. Default `~/.omp/mcp-guard-seen.json`. */
	snapshot?: string;
	/** Where omp writes its process log. Default `~/.omp/logs`, or `$XDG_STATE_HOME/omp/logs` when that exists. */
	logDir?: string;
	/** Exact server names (MCP config keys) whose results pass without a label. */
	trustedServers?: string[];
	/** Exact server names: calls are blocked by tool-name prefix, results are withheld. */
	blockedServers?: string[];
	/** Exact `mcp__` tool names that are always blocked. */
	blockedTools?: string[];
	/** `open` (default): calls not blocked by a rule pass. `allowlist`: only `allowTools` pass. */
	callPolicy?: CallPolicy;
	/** Exact `mcp__` tool names allowed under `callPolicy: "allowlist"`. */
	allowTools?: string[];
	/** What happens to a tool with no pin: `allow` (default, recorded as new) or `block`. */
	unpinned?: UnpinnedPolicy;
	/** Block every MCP call while omp's effective `mcp.enableProjectConfig` is not false. Default true. */
	requireProjectMcpOff?: boolean;
	/** `drop` (default) removes the MCP Server Instructions section from the system prompt. */
	serverInstructions?: InstructionsPolicy;
	/** Block tool names that omp's process log reports as collided. Default true. */
	blockCollided?: boolean;
}

export const CONFIG_KEYS: readonly (keyof McpGuardConfig)[] = [
	"ledger",
	"pins",
	"snapshot",
	"logDir",
	"trustedServers",
	"blockedServers",
	"blockedTools",
	"callPolicy",
	"allowTools",
	"unpinned",
	"requireProjectMcpOff",
	"serverInstructions",
	"blockCollided",
];

export interface GuardSettings {
	ledger: string;
	pins: string;
	snapshot: string;
	logDir: string;
	trustedServers: Set<string>;
	blockedServers: Set<string>;
	blockedTools: Set<string>;
	callPolicy: CallPolicy;
	allowTools: Set<string>;
	unpinned: UnpinnedPolicy;
	requireProjectMcpOff: boolean;
	serverInstructions: InstructionsPolicy;
	blockCollided: boolean;
}

export interface GuardOptions extends McpGuardConfig {
	/** The config file to read; `null` reads none. Defaults to `~/.config/omp-mcp-guard/config.json`. */
	configPath?: string | null;
}

export function defaultConfigPath(): string {
	return path.join(os.homedir(), ".config", "omp-mcp-guard", "config.json");
}

export function defaultLogDir(): string {
	const state = process.env.XDG_STATE_HOME;
	if (process.platform === "linux" && state) {
		const root = path.join(state, "omp");
		try {
			if (fs.statSync(root).isDirectory()) return path.join(root, "logs");
		} catch {}
	}
	return path.join(os.homedir(), ".omp", "logs");
}

const DEFAULTS = {
	ledger: () => path.join(os.homedir(), ".omp", "mcp-guard-ledger.jsonl"),
	pins: () => path.join(os.homedir(), ".config", "omp-mcp-guard", "pins.json"),
	snapshot: () => path.join(os.homedir(), ".omp", "mcp-guard-seen.json"),
	logDir: defaultLogDir,
};

/** A path for messages, with the home directory written as `~`. */
export function shown(file: string): string {
	const rel = path.relative(os.homedir(), file);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel}` : file;
}

export function sha256(text: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function stringList(value: unknown, key: string, file: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.trim() === "")) throw new Error(`${file}: "${key}" must be a list of strings`);
	return value as string[];
}

function oneOf<T extends string>(value: unknown, key: string, allowed: readonly T[], file: string): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`${file}: "${key}" must be one of ${allowed.map(a => `"${a}"`).join(", ")}`);
	return value as T;
}

function bool(value: unknown, key: string, file: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${file}: "${key}" must be true or false`);
	return value;
}

function pathValue(value: unknown, key: string, file: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${file}: "${key}" must be a path`);
	return value;
}

/** Reads the config file; a missing file is an empty config, anything malformed throws. */
export function loadConfig(file: string): McpGuardConfig {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
	return parseConfig(text, file);
}

export function parseConfig(text: string, file: string): McpGuardConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(`${file}: not valid JSON (${(err as Error).message})`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file}: expected a JSON object`);
	const data = raw as Record<string, unknown>;
	const unknown = Object.keys(data).filter(key => !(CONFIG_KEYS as readonly string[]).includes(key));
	if (unknown.length > 0) throw new Error(`${file}: unknown setting ${unknown.map(key => `"${key}"`).join(", ")}`);
	return {
		ledger: pathValue(data.ledger, "ledger", file),
		pins: pathValue(data.pins, "pins", file),
		snapshot: pathValue(data.snapshot, "snapshot", file),
		logDir: pathValue(data.logDir, "logDir", file),
		trustedServers: stringList(data.trustedServers, "trustedServers", file),
		blockedServers: stringList(data.blockedServers, "blockedServers", file),
		blockedTools: stringList(data.blockedTools, "blockedTools", file),
		callPolicy: oneOf(data.callPolicy, "callPolicy", ["open", "allowlist"] as const, file),
		allowTools: stringList(data.allowTools, "allowTools", file),
		unpinned: oneOf(data.unpinned, "unpinned", ["allow", "block"] as const, file),
		requireProjectMcpOff: bool(data.requireProjectMcpOff, "requireProjectMcpOff", file),
		serverInstructions: oneOf(data.serverInstructions, "serverInstructions", ["drop", "keep"] as const, file),
		blockCollided: bool(data.blockCollided, "blockCollided", file),
	};
}

function resolvePath(value: string | undefined, key: keyof typeof DEFAULTS): string {
	if (value === undefined) return DEFAULTS[key]();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	if (!path.isAbsolute(value)) throw new Error(`"${key}" must be absolute or start with ~/ (got "${value}")`);
	return value;
}

function toolNames(list: string[] | undefined, key: string): Set<string> {
	for (const name of list ?? []) if (!isMcpToolName(name)) throw new Error(`"${key}" holds tool names starting with mcp__ (got "${name}")`);
	return new Set(list ?? []);
}

/** Applies defaults and checks every value; throws on the first invalid one. */
export function resolveSettings(config: McpGuardConfig): GuardSettings {
	const trustedServers = new Set(config.trustedServers ?? []);
	const blockedServers = new Set(config.blockedServers ?? []);
	const both = [...trustedServers].filter(name => blockedServers.has(name));
	if (both.length > 0) throw new Error(`a server cannot be both trusted and blocked: ${both.join(", ")}`);
	return {
		ledger: resolvePath(config.ledger, "ledger"),
		pins: resolvePath(config.pins, "pins"),
		snapshot: resolvePath(config.snapshot, "snapshot"),
		logDir: resolvePath(config.logDir, "logDir"),
		trustedServers,
		blockedServers,
		blockedTools: toolNames(config.blockedTools, "blockedTools"),
		callPolicy: config.callPolicy ?? "open",
		allowTools: toolNames(config.allowTools, "allowTools"),
		unpinned: config.unpinned ?? "allow",
		requireProjectMcpOff: config.requireProjectMcpOff ?? true,
		serverInstructions: config.serverInstructions ?? "drop",
		blockCollided: config.blockCollided ?? true,
	};
}

function stripUndefined<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

export interface LoadedSettings {
	settings: GuardSettings;
	/** Why the config could not be used; the guard then fails closed. */
	error?: string;
	/** SHA-256 of the config file as read, or null when there was none. */
	configSha256: string | null;
}

/**
 * The settings a guard runs with: the config file, then explicit options on top. An unusable
 * config is reported as `error` with the defaults (and the configured ledger when that part is
 * valid), so the guard can stay loaded and fail closed instead of disappearing.
 */
export function guardSettings(options: GuardOptions): LoadedSettings {
	const { configPath = defaultConfigPath(), ...overrides } = options;
	let config: McpGuardConfig = {};
	let configSha256: string | null = null;
	try {
		if (configPath !== null) {
			let text: string | null = null;
			try {
				text = fs.readFileSync(configPath, "utf8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
			if (text !== null) {
				configSha256 = sha256(text);
				config = parseConfig(text, configPath);
			}
		}
		config = { ...stripUndefined(config), ...stripUndefined(overrides) };
		return { settings: resolveSettings(config), configSha256 };
	} catch (err) {
		let ledger = DEFAULTS.ledger();
		try {
			ledger = resolvePath(config.ledger ?? overrides.ledger, "ledger");
		} catch {}
		return { settings: { ...resolveSettings({}), ledger }, error: (err as Error).message, configSha256 };
	}
}
