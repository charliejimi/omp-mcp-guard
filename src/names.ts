// MCP tool names as omp 18.2.8 mints them (mcp/tool-bridge.ts), so the guard can tell which
// registered names a configured server's tools take. omp lists MCP tools by name only before a
// call; the raw server name appears in `details.serverName` after it.

export const MCP_PREFIX = "mcp__";
const MAX_TOOL_NAME = 64;
const HASH_LENGTH = 8;

export function isMcpToolName(name: unknown): name is string {
	return typeof name === "string" && name.startsWith(MCP_PREFIX);
}

export function sanitizeNamePart(value: string, fallback: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	return sanitized.length > 0 ? sanitized : fallback;
}

function capLength(name: string): string {
	if (name.length <= MAX_TOOL_NAME) return name;
	const hash = Bun.hash(name).toString(36).slice(0, HASH_LENGTH);
	return `${name.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`;
}

/** The registry name omp gives `tool` of `server`. */
export function mcpToolName(server: string, tool: string): string {
	const s = sanitizeNamePart(server, "server");
	let t = sanitizeNamePart(tool, "tool");
	if (t.startsWith(`${s}_`)) t = t.slice(s.length + 1);
	return capLength(`${MCP_PREFIX}${s}_${t}`);
}

/** Every tool of `server` starts with this, and so do the tools of any server whose name extends it. */
export function serverPrefix(server: string): string {
	return `${MCP_PREFIX}${sanitizeNamePart(server, "server")}_`;
}

/** The device a `read`/`write` path names, read the way omp parses `xd://` URLs; null otherwise. */
export function xdTarget(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed.toLowerCase().startsWith("xd://")) return null;
	const name = trimmed.slice("xd://".length);
	if (name.length === 0 || /[/?#]/.test(name)) return null;
	return name;
}

// The schemes omp 18.2.8's internal router serves itself, plus the web and file schemes `read`
// handles before it reaches the router. A read of any other scheme falls through to an MCP resource,
// served by whichever connected server advertises it.
const NON_MCP_SCHEMES = new Set(["omp", "agent", "artifact", "memory", "local", "vault", "skill", "rule", "security", "issue", "pr", "history", "ssh", "xd", "http", "https", "file", "data"]);

export interface McpResourceRef {
	/** The resource URI the server is asked for. */
	uri: string;
	/** Its scheme, lower-cased: the only hint of which server answers, and one the server picks itself. */
	scheme: string;
}

/**
 * The MCP resource a `read` path names: `mcp://<resource-uri>`, or a server's own `scheme://…` that
 * no omp handler claims. `opaque` also accepts `scheme:rest` without `//`, which omp routes the same
 * way; a check made before the call leaves it off, so a file name with a colon is not taken for one.
 */
export function mcpResource(value: unknown, opaque = false): McpResourceRef | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	const match = /^([A-Za-z][A-Za-z0-9+.-]*):(\/\/)?/.exec(trimmed);
	if (!match || match[1]!.length < 2) return null;
	const scheme = match[1]!.toLowerCase();
	if (scheme === "mcp") {
		const uri = trimmed.slice(match[0].length);
		if (uri.length === 0) return null;
		return { uri, scheme: (/^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri)?.[1] ?? "").toLowerCase() };
	}
	if (NON_MCP_SCHEMES.has(scheme) || (!match[2] && !opaque)) return null;
	return { uri: trimmed, scheme };
}

/** A config key or server name ends up in model context and in notices; keep only name characters. */
export function safeName(value: unknown): string {
	return String(value ?? "")
		.replace(/[^A-Za-z0-9._:-]/g, "_")
		.slice(0, 64);
}

export interface PrefixOverlap {
	a: string;
	b: string;
	/** `same`: both names mint one prefix; `prefix`: a's prefix also starts b's tools. */
	kind: "same" | "prefix";
}

/** Server names whose tool names cannot be told apart by prefix. */
export function prefixOverlaps(servers: readonly string[]): PrefixOverlap[] {
	const out: PrefixOverlap[] = [];
	const names = [...new Set(servers)];
	for (const [i, a] of names.entries()) {
		for (const b of names.slice(i + 1)) {
			const pa = serverPrefix(a);
			const pb = serverPrefix(b);
			if (pa === pb) out.push({ a, b, kind: "same" });
			else if (pb.startsWith(pa)) out.push({ a, b, kind: "prefix" });
			else if (pa.startsWith(pb)) out.push({ a: b, b: a, kind: "prefix" });
		}
	}
	return out;
}
