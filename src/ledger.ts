// The JSONL ledger every part of the guard appends to, one line per decision, so "which server
// answered, what was blocked or withheld, and why" can be answered without asking the agent. Lines
// carry names, decisions, reasons, and counts; never tool inputs or result text. Writing never
// throws: a full disk must not turn into a tool failure. Fields are bounded so a server cannot grow
// the ledger through a long name.
import * as fs from "node:fs";
import * as path from "node:path";

export type LedgerEntry = { event: string } & Record<string, unknown>;

export interface Ledger {
	readonly file: string;
	append(entry: LedgerEntry): void;
}

const MAX_STRING = 300;
const MAX_LIST = 20;

function bounded(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
	if (Array.isArray(value)) return value.slice(0, MAX_LIST).map(item => bounded(item, depth + 1));
	if (value && typeof value === "object" && depth < 2) {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, bounded(item, depth + 1)]));
	}
	return value;
}

export function openLedger(file: string): Ledger {
	return {
		file,
		append(entry) {
			try {
				fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
				fs.appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...(bounded(entry) as LedgerEntry) })}\n`, { mode: 0o600 });
			} catch {}
		},
	};
}

/** Every well-formed line of a ledger; malformed lines are skipped. */
export function readLedger(file: string): LedgerEntry[] {
	const text = fs.readFileSync(file, "utf8");
	const out: LedgerEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as unknown;
			if (entry && typeof entry === "object" && typeof (entry as LedgerEntry).event === "string") out.push(entry as LedgerEntry);
		} catch {}
	}
	return out;
}

/** The session id omp passes in the handler context, or "unknown". */
export function sessionOf(ctx: unknown): string {
	try {
		const id = (ctx as { sessionManager?: { getSessionId?: () => unknown } })?.sessionManager?.getSessionId?.();
		return typeof id === "string" ? id : "unknown";
	} catch {
		return "unknown";
	}
}
