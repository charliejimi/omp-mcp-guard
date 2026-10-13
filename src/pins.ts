// Description pins. omp passes an MCP server's tool descriptions and parameter schemas to the model
// as they are and rebinds them on `tools/list_changed` without asking again. A pin is the SHA-256
// of what a person reviewed; the call guard compares it with what omp lists right before each call.
// The snapshot is what the last session saw, so `mcp-guard review` can show it and `pin` can accept it.
import * as fs from "node:fs";
import * as path from "node:path";
import { sha256 } from "./config";
import { matchPattern } from "./patterns";

export interface ToolLike {
	name: string;
	description?: unknown;
	parameters?: unknown;
}

/** JSON with object keys sorted at every level, so two equal schemas print alike. */
export function canonicalJson(value: unknown): string {
	const sort = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sort);
		if (v && typeof v === "object") {
			return Object.fromEntries(
				Object.keys(v as Record<string, unknown>)
					.sort()
					.map(key => [key, sort((v as Record<string, unknown>)[key])]),
			);
		}
		return v;
	};
	return JSON.stringify(sort(value ?? null)) ?? "null";
}

export function fingerprint(tool: ToolLike): string {
	return sha256(canonicalJson([tool.name, String(tool.description ?? ""), tool.parameters ?? null]));
}

/** Every string inside a schema (descriptions, titles, enum values), one per line. */
export function schemaText(schema: unknown): string {
	const out: string[] = [];
	const visit = (v: unknown, depth: number) => {
		if (depth > 12 || out.length > 500) return;
		if (typeof v === "string") out.push(v);
		else if (Array.isArray(v)) for (const item of v) visit(item, depth + 1);
		else if (v && typeof v === "object") for (const item of Object.values(v as Record<string, unknown>)) visit(item, depth + 1);
	};
	visit(schema, 0);
	return out.join("\n");
}

/** The injection pattern a tool's description or schema matches, if any. */
export function descriptionPattern(tool: ToolLike): string | null {
	return matchPattern(`${String(tool.description ?? "")}\n${schemaText(tool.parameters)}`);
}

export interface Pin {
	sha256: string;
	pinnedAt: string;
}

export type Pins = Record<string, Pin>;

export interface LoadedPins {
	pins: Pins;
	/** SHA-256 of the pins file as read, or null when there was none. */
	sha256: string | null;
	error?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function loadPins(file: string): LoadedPins {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { pins: {}, sha256: null };
		return { pins: {}, sha256: null, error: `${file}: ${(err as Error).message}` };
	}
	const digest = sha256(text);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { pins: {}, sha256: digest, error: `${file}: not valid JSON (${(err as Error).message})` };
	}
	const tools = (raw as { tools?: unknown } | null)?.tools;
	if (!tools || typeof tools !== "object" || Array.isArray(tools)) return { pins: {}, sha256: digest, error: `${file}: expected {"version": 1, "tools": {...}}` };
	const pins: Pins = {};
	for (const [name, pin] of Object.entries(tools as Record<string, unknown>)) {
		const hash = (pin as { sha256?: unknown } | null)?.sha256;
		if (typeof hash !== "string" || !HEX64.test(hash)) return { pins: {}, sha256: digest, error: `${file}: the pin for ${name} is not a SHA-256 hex string` };
		const at = (pin as { pinnedAt?: unknown }).pinnedAt;
		pins[name] = { sha256: hash, pinnedAt: typeof at === "string" ? at : "" };
	}
	return { pins, sha256: digest };
}

/** Writes a JSON file through a temporary file and a rename, readable by the user only. */
export function writePrivateJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
}

export function savePins(file: string, pins: Pins): void {
	const sorted = Object.fromEntries(Object.keys(pins).sort().map(name => [name, pins[name]]));
	writePrivateJson(file, { version: 1, tools: sorted });
}

export type ToolState = "pinned" | "changed" | "new";

export interface SeenTool {
	name: string;
	sha256: string;
	state: ToolState;
	pattern: string | null;
	/** The pinned hash, when it differs. */
	pinned?: string;
	description: string;
	parameters: unknown;
}

export function classifyOne(tool: ToolLike, pins: Pins, digest = fingerprint(tool)): SeenTool {
	const pin = pins[tool.name];
	const state: ToolState = !pin ? "new" : pin.sha256 === digest ? "pinned" : "changed";
	return {
		name: tool.name,
		sha256: digest,
		state,
		pattern: descriptionPattern(tool),
		...(state === "changed" ? { pinned: pin.sha256 } : {}),
		description: String(tool.description ?? ""),
		parameters: tool.parameters ?? null,
	};
}

export function classify(tools: readonly ToolLike[], pins: Pins): SeenTool[] {
	return tools.map(tool => classifyOne(tool, pins));
}

export interface Snapshot {
	version: 1;
	takenAt: string;
	session: string;
	tools: SeenTool[];
}

export function readSnapshot(file: string): Snapshot {
	const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
	if (!raw || raw.version !== 1 || !Array.isArray(raw.tools)) throw new Error(`${file}: not an omp-mcp-guard snapshot`);
	return raw;
}
