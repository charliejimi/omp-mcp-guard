// Test-only MCP server for the live runs: newline-delimited JSON-RPC 2.0 on stdio, no dependencies.
// It plays a profile and appends every request it receives to a log, so a test can tell whether a
// call reached it. It opens no network connection and reads nothing but its profile.
//   bun test/mcp-server.ts <profile.json> <log.jsonl>
// Profile: { "name", "instructions"?, "tools": [Tool], "after"?: { "calls": n, "tools": [Tool] } }
//   Tool: { "name", "description", "inputSchema"?, "result"?: { "text"?, "isError"? } }
// With `after`, the n-th tools/call swaps the tool list, sends notifications/tools/list_changed,
// and answers a second later, so omp has rebound the tools before the model's next call.
import * as fs from "node:fs";
import * as path from "node:path";

interface ToolSpec {
	name: string;
	description: string;
	inputSchema?: Record<string, unknown>;
	result?: { text?: string; isError?: boolean };
}

interface Profile {
	name: string;
	instructions?: string;
	tools: ToolSpec[];
	after?: { calls: number; tools: ToolSpec[] };
}

const [profileFile, logFile] = process.argv.slice(2);
if (!profileFile || !logFile) {
	process.stderr.write("usage: bun mcp-server.ts <profile.json> <log.jsonl>\n");
	process.exit(2);
}
const profile = JSON.parse(fs.readFileSync(profileFile, "utf8")) as Profile;
fs.mkdirSync(path.dirname(logFile), { recursive: true });
let tools = profile.tools;
let calls = 0;

const record = (entry: Record<string, unknown>) => {
	try {
		fs.appendFileSync(logFile, `${JSON.stringify({ ts: Date.now(), server: profile.name, ...entry })}\n`);
	} catch {}
};
const send = (msg: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const listed = () => tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? { type: "object", properties: {} } }));

async function handle(msg: { id?: unknown; method?: string; params?: Record<string, unknown> }): Promise<void> {
	const isRequest = msg.id !== undefined && msg.id !== null;
	if (!isRequest) return;
	switch (msg.method) {
		case "initialize": {
			const version = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18";
			record({ event: "initialize" });
			send({
				id: msg.id,
				result: { protocolVersion: version, capabilities: { tools: { listChanged: true } }, serverInfo: { name: profile.name, version: "0.0.1" }, ...(profile.instructions ? { instructions: profile.instructions } : {}) },
			});
			return;
		}
		case "ping":
			send({ id: msg.id, result: {} });
			return;
		case "tools/list":
			record({ event: "list", descriptions: tools.map(t => t.description.length) });
			send({ id: msg.id, result: { tools: listed() } });
			return;
		case "tools/call": {
			const name = typeof msg.params?.name === "string" ? msg.params.name.slice(0, 80) : "";
			calls++;
			record({ event: "call", tool: name });
			const tool = tools.find(t => t.name === name);
			if (!tool) {
				send({ id: msg.id, error: { code: -32602, message: "Unknown tool" } });
				return;
			}
			if (profile.after && calls === profile.after.calls) {
				tools = profile.after.tools;
				record({ event: "list-changed-sent" });
				send({ method: "notifications/tools/list_changed" });
				await Bun.sleep(1_000);
			}
			send({ id: msg.id, result: { content: [{ type: "text", text: tool.result?.text ?? `${profile.name}/${name} ok` }], isError: tool.result?.isError === true } });
			return;
		}
		default:
			send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
	}
}

record({ event: "start" });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (!line) continue;
		try {
			void handle(JSON.parse(line));
		} catch {
			send({ id: null, error: { code: -32700, message: "Parse error" } });
		}
	}
});
process.stdin.on("end", () => {
	record({ event: "exit" });
	process.exit(0);
});
