// Test-only MCP server over streamable HTTP on 127.0.0.1, run inside the test process, so omp
// connects within its 250 ms startup window (a stdio server it has to spawn can miss it, and omp
// 18.2.8 then leaves that server's tools out of a headless session). It plays a profile like
// test/mcp-server.ts and appends every request to the same kind of log.
// With `after`, the n-th tools/call swaps the tool list and answers as an SSE stream:
// notifications/tools/list_changed first, the result a second later, so omp has rebound the tools
// before the model's next call.
import * as fs from "node:fs";
import * as path from "node:path";

export interface ToolSpec {
	name: string;
	description: string;
	inputSchema?: Record<string, unknown>;
	result?: { text?: string; isError?: boolean };
}

export interface Profile {
	name: string;
	instructions?: string;
	tools: ToolSpec[];
	after?: { calls: number; tools: ToolSpec[] };
}

export interface McpHttpServer {
	name: string;
	url: string;
	stop(): void;
}

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };

export function startMcpHttpServer(profile: Profile, logFile: string): McpHttpServer {
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	let tools = profile.tools;
	let calls = 0;
	const record = (entry: Record<string, unknown>) => {
		try {
			fs.appendFileSync(logFile, `${JSON.stringify({ ts: Date.now(), server: profile.name, ...entry })}\n`);
		} catch {}
	};
	const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
	const listed = () => tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? { type: "object", properties: {} } }));

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname !== "/mcp") return new Response(null, { status: 404 });
			if (req.method === "DELETE") return new Response(null, { status: 200 });
			if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } });
			let msg: Message;
			try {
				msg = (await req.json()) as Message;
			} catch {
				return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			}
			if (!msg || typeof msg !== "object" || Array.isArray(msg)) return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
			const isRequest = msg.id !== undefined && msg.id !== null;
			if (!isRequest) return new Response(null, { status: 202 });
			switch (msg.method) {
				case "initialize": {
					const version = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18";
					record({ event: "initialize" });
					return json(
						200,
						{
							jsonrpc: "2.0",
							id: msg.id,
							result: { protocolVersion: version, capabilities: { tools: { listChanged: true } }, serverInfo: { name: profile.name, version: "0.0.1" }, ...(profile.instructions ? { instructions: profile.instructions } : {}) },
						},
						{ "Mcp-Session-Id": crypto.randomUUID() },
					);
				}
				case "ping":
					return json(200, { jsonrpc: "2.0", id: msg.id, result: {} });
				case "tools/list":
					record({ event: "list", descriptions: tools.map(t => t.description.length) });
					return json(200, { jsonrpc: "2.0", id: msg.id, result: { tools: listed() } });
				case "tools/call": {
					const name = typeof msg.params?.name === "string" ? msg.params.name.slice(0, 80) : "";
					calls++;
					record({ event: "call", tool: name });
					const tool = tools.find(t => t.name === name);
					if (!tool) return json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Unknown tool" } });
					const result = { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: tool.result?.text ?? `${profile.name}/${name} ok` }], isError: tool.result?.isError === true } };
					if (!profile.after || calls !== profile.after.calls) return json(200, result);
					tools = profile.after.tools;
					record({ event: "list-changed-sent" });
					const encoder = new TextEncoder();
					const stream = new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`));
							await Bun.sleep(1_000);
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(result)}\n\n`));
							controller.close();
						},
					});
					return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
				}
				default:
					return json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
			}
		},
	});
	record({ event: "start" });
	return { name: profile.name, url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) };
}
