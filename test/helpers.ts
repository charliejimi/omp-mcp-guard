import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

export const PACKAGE = path.resolve(import.meta.dir, "..");

/** The temporary root test/run.ts created; test/setup.ts already checked HOME and TMPDIR are inside it. */
export const TEST_ROOT = fs.realpathSync(process.env.MG_TEST_ROOT ?? "/nonexistent-test-root");

/** Deletes `target` only when its real path is strictly inside the suite's temporary root. */
export function safeRemove(target: string): void {
	let real: string;
	try {
		real = fs.realpathSync(target);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	const rel = path.relative(TEST_ROOT, real);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to delete ${target}: outside the test root`);
	fs.rmSync(real, { recursive: true, force: true });
}

const created: string[] = [];

/** A new directory under the suite's TMPDIR. */
export function tempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	created.push(dir);
	return dir;
}

export function removeCreated(): void {
	for (const dir of created.splice(0)) safeRemove(dir);
}

export function writeFile(file: string, text: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

export type LedgerLine = Record<string, unknown> & { event: string };

export function ledgerLines(file: string): LedgerLine[] {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as LedgerLine);
}

export interface ToolInfoLike {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	sourceInfo: { path: string; source: string; scope: string; origin: string };
}

/** A tool as omp 18.2.8's getAllTools() lists an MCP tool. */
export function mcpTool(name: string, description: string, parameters: Record<string, unknown> = { type: "object", properties: {} }): ToolInfoLike {
	return { name, description, parameters, sourceInfo: { path: `<mcp:${name}>`, source: "mcp", scope: "temporary", origin: "top-level" } };
}

export function builtinTool(name: string): ToolInfoLike {
	return { name, description: `The ${name} tool.`, parameters: { type: "object", properties: {} }, sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" } };
}

type Guard = "call" | "result" | "instructions";
const FACTORIES: Record<Guard, { file: string; factory: string }> = {
	call: { file: "call-guard.ts", factory: "createMcpCallGuard" },
	result: { file: "result-guard.ts", factory: "createMcpResultGuard" },
	instructions: { file: "instructions-guard.ts", factory: "createMcpInstructionsGuard" },
};

let entries = 0;

/**
 * An extension entry that loads one guard with explicit options and no config file unless
 * `configPath` is given. `projectMcp` stands in for omp's effective `mcp.enableProjectConfig`:
 * a value, or "throw" for a reader that fails. The call guard reads no process log unless `logDir`
 * is given.
 */
export function writeEntry(dir: string, guard: Guard, options: Record<string, unknown> = {}, extra: { projectMcp?: unknown } = {}): string {
	fs.mkdirSync(dir, { recursive: true });
	const entry = path.join(dir, `${guard}-guard-${++entries}.ts`);
	const { file, factory } = FACTORIES[guard];
	const base: Record<string, unknown> = { configPath: null, ...(guard === "call" ? { logDir: null } : {}), ...options };
	const opts = JSON.stringify(base, null, "\t");
	let reader = "";
	if (guard === "call") {
		const value = "projectMcp" in extra ? extra.projectMcp : false;
		reader = value === "throw" ? `, projectMcpEnabled: () => { throw new Error("settings unavailable"); }` : `, projectMcpEnabled: () => ${JSON.stringify(value)}`;
	}
	const source = [`import { ${factory} } from ${JSON.stringify(path.join(PACKAGE, "src", file))};`, `export default ${factory}({ ...${opts}${reader} });`];
	fs.writeFileSync(entry, `${source.join("\n")}\n`);
	return entry;
}

let registry: { auth: AuthStorage; models: ModelRegistry; dir: string } | undefined;

async function models(): Promise<ModelRegistry> {
	if (!registry) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-auth-"));
		const auth = await AuthStorage.create(path.join(dir, "auth.db"));
		registry = { auth, models: new ModelRegistry(auth), dir };
	}
	return registry.models;
}

export function closeRegistry(): void {
	if (!registry) return;
	registry.auth.close();
	safeRemove(registry.dir);
	registry = undefined;
}

export interface Notice {
	message: string;
	type: string | undefined;
}

export interface ToolCallOutcome {
	block?: boolean;
	reason?: string;
}

export interface Content {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface ToolResultOutcome {
	content?: Content[];
	details?: unknown;
	isError?: boolean;
}

export interface ResultEvent {
	toolName: string;
	input?: Record<string, unknown>;
	content: Content[];
	details?: unknown;
	isError?: boolean;
	toolCallId?: string;
}

export interface Loaded {
	runner: ExtensionRunner;
	notices: Notice[];
	sessionId: string;
	toolCall(toolName: string, input: Record<string, unknown>, toolCallId?: string): Promise<ToolCallOutcome | undefined>;
	toolResult(event: ResultEvent): Promise<ToolResultOutcome | undefined>;
	beforeAgentStart(systemPrompt: string[]): Promise<{ systemPrompt?: string[] } | undefined>;
	mcpNotification(server: string, method: string): Promise<void>;
	turnStart(): Promise<void>;
}

let calls = 0;

/**
 * Loads extension entries through omp's own loader and runner, in order, and starts the session in
 * `cwd`. `tools` backs getAllTools(); the array is read live, so a test can change a description
 * the way omp rebinds tools after `tools/list_changed`.
 */
export async function loadExtensions(paths: string[], cwd: string, tools: ToolInfoLike[] = []): Promise<Loaded> {
	const result = await discoverAndLoadExtensions(paths, cwd, undefined, undefined, { ambient: false });
	const extensions = paths.map(p => result.extensions.find(ext => ext.path === p)).filter(ext => ext !== undefined);
	const loadErrors = result.errors.filter(err => paths.includes(err.path));
	if (loadErrors.length > 0 || extensions.length !== paths.length) {
		throw new Error(`extensions did not load: ${JSON.stringify(loadErrors)} (${extensions.length} loaded)`);
	}
	const sessionManager = SessionManager.inMemory(cwd);
	const runner = new ExtensionRunner(extensions, result.runtime, cwd, sessionManager, await models());
	const notices: Notice[] = [];
	const ui = { notify: (message: string, type?: string) => notices.push({ message, type }) };
	runner.initialize({ getActiveTools: () => tools.map(t => t.name), getAllTools: () => tools } as never, {} as never, undefined, ui as never, "rpc");
	await runner.emit({ type: "session_start" } as never);
	return {
		runner,
		notices,
		sessionId: sessionManager.getSessionId(),
		toolCall: (toolName, input, toolCallId = `call-${++calls}`) =>
			runner.emitToolCall({ type: "tool_call", toolCallId, toolName, input } as never) as Promise<ToolCallOutcome | undefined>,
		toolResult: event =>
			runner.emitToolResult({
				type: "tool_result",
				toolCallId: event.toolCallId ?? `call-${++calls}`,
				input: {},
				isError: false,
				details: undefined,
				...event,
			} as never) as Promise<ToolResultOutcome | undefined>,
		beforeAgentStart: async systemPrompt => (await runner.emitBeforeAgentStart("prompt", undefined, systemPrompt)) as { systemPrompt?: string[] } | undefined,
		mcpNotification: async (server, method) => {
			await runner.emit({ type: "mcp_notification", server, method, params: {} } as never);
		},
		turnStart: async () => {
			await runner.emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() } as never);
		},
	};
}

export function textOf(content: Content[] | undefined): string {
	return (content ?? [])
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}
