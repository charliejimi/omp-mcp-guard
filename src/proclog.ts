// omp writes two MCP facts only to its process log, `omp.<date>.<pid>.log` (Day27: neither reaches
// stdout, stderr, or the event stream): a name collision where it silently kept one server, and a
// server that failed to load. The guard runs in the same process, so it can read its own log.
// The wording is omp 18.2.8's; only the tail of each file is read.
import * as fs from "node:fs";
import * as path from "node:path";

export interface Collision {
	name: string;
	keptServer: string;
	ignoredServer: string;
}

export interface ProcessLogFacts {
	collisions: Collision[];
	loadFailures: Array<{ server: string }>;
	files: number;
}

export const COLLISION_MESSAGE = "MCP tool name collision; keeping stable winner";
export const LOAD_FAILED_MESSAGE = "MCP tool load failed";
const MAX_BYTES = 2 * 1024 * 1024;

function tail(file: string, maxBytes: number): string {
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const buf = Buffer.alloc(size - start);
		fs.readSync(fd, buf, 0, buf.length, start);
		const text = buf.toString("utf8");
		return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
	} finally {
		fs.closeSync(fd);
	}
}

function ownLogs(dir: string, pid: number): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const own = new RegExp(`^omp\\.\\d{4}-\\d{2}-\\d{2}\\.${pid}\\.log(\\.\\d+)?$`);
	return names.filter(n => own.test(n)).sort();
}

/** Names and sizes of this process's log files; it changes whenever omp writes to them. */
export function logSignature(dir: string, pid: number): string {
	return ownLogs(dir, pid)
		.map(name => {
			try {
				return `${name}:${fs.statSync(path.join(dir, name)).size}`;
			} catch {
				return `${name}:-`;
			}
		})
		.join("|");
}

export function readProcessLog(dir: string, pid: number, maxBytes = MAX_BYTES): ProcessLogFacts {
	const facts: ProcessLogFacts = { collisions: [], loadFailures: [], files: 0 };
	const seen = new Set<string>();
	for (const name of ownLogs(dir, pid)) {
		let text: string;
		try {
			text = tail(path.join(dir, name), maxBytes);
		} catch {
			continue;
		}
		facts.files++;
		for (const line of text.split("\n")) {
			if (!line.includes("MCP tool")) continue;
			let r: Record<string, unknown>;
			try {
				r = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (r.pid !== pid) continue;
			if (r.message === COLLISION_MESSAGE && typeof r.name === "string") {
				const key = `c\0${r.name}\0${String(r.keptServer)}\0${String(r.ignoredServer)}`;
				if (seen.has(key)) continue;
				seen.add(key);
				facts.collisions.push({ name: r.name, keptServer: String(r.keptServer ?? ""), ignoredServer: String(r.ignoredServer ?? "") });
			} else if (r.message === LOAD_FAILED_MESSAGE && typeof r.path === "string" && r.path.startsWith("mcp:")) {
				const server = r.path.slice(4);
				const key = `f\0${server}`;
				if (seen.has(key)) continue;
				seen.add(key);
				facts.loadFailures.push({ server });
			}
		}
	}
	return facts;
}
