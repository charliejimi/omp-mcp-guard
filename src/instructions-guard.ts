// omp-mcp-guard, instructions filter: omp 18.2.8 puts every connected MCP server's `initialize`
// instructions into the system prompt, under "MCP Server Instructions" (sdk.ts), where server text
// carries system-prompt authority. omp 18.3.1 added a per-server `instructions: false`; 18.2.8 has
// no switch. This filter removes the section from every request through `before_agent_start`.
//
// It removes the whole section, from its heading to the end of that system-prompt part, and never
// keeps one server's block: the text is server-controlled and can contain a forged `### <name>`
// heading for another server. In 18.2.8 the section is the last generated piece of the appended
// prompt, which ends its part; a user `--append-system-prompt` that follows it goes too, and the
// ledger says so. omp passes the original prompt when this handler fails, so it is written not to.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type GuardOptions, guardSettings, shown } from "./config";
import { openLedger, sessionOf } from "./ledger";
import { safeName } from "./names";

/** omp 18.2.8's heading and preamble for the section (sdk.ts). */
export const INSTRUCTIONS_HEADING =
	"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.";
/** omp 18.2.8's heading in front of a user-appended system prompt (system-prompt.ts). */
export const USER_APPEND_HEADING =
	"## User Instructions\n\nThe following instructions are user-authored (session configuration or CLI). They are authoritative and supersede conflicting guidance above.";

export interface Dropped {
	chars: number;
	/** Names after `### ` headings in the dropped text: what omp wrote, plus anything a server forged. */
	servers: string[];
	userAppendDropped: boolean;
}

function headingAt(part: string): number {
	if (part.startsWith(INSTRUCTIONS_HEADING)) return 0;
	const i = part.indexOf(`\n${INSTRUCTIONS_HEADING}`);
	return i === -1 ? -1 : i + 1;
}

export function dropServerInstructions(systemPrompt: readonly string[]): { parts: string[]; dropped: Dropped | null } {
	let dropped: Dropped | null = null;
	const parts = systemPrompt.map(part => {
		if (typeof part !== "string") return part;
		const at = headingAt(part);
		if (at === -1) return part;
		const removed = part.slice(at);
		const servers = [...removed.matchAll(/^### (.{1,200})$/gm)].map(m => safeName(m[1])).slice(0, 20);
		dropped = {
			chars: (dropped?.chars ?? 0) + removed.length,
			servers: [...(dropped?.servers ?? []), ...servers],
			userAppendDropped: (dropped?.userAppendDropped ?? false) || removed.includes(USER_APPEND_HEADING),
		};
		return part.slice(0, at);
	});
	return { parts, dropped };
}

export function createMcpInstructionsGuard(options: GuardOptions = {}) {
	return function mcpInstructionsGuard(pi: ExtensionAPI): void {
		const { settings, error } = guardSettings(options);
		const ledger = openLedger(settings.ledger);
		const keep = !error && settings.serverInstructions === "keep";

		pi.on("session_start", (_event, ctx) => {
			if (keep) return;
			let present = false;
			try {
				present = dropServerInstructions(ctx.getSystemPrompt()).dropped !== null;
			} catch {}
			ctx.ui.notify(
				`omp-mcp-guard: MCP server instructions are dropped from the system prompt on every request${present ? " (a section is present now)" : ""}. Tools stay usable. Ledger ${shown(settings.ledger)}.`,
				"info",
			);
		});

		pi.on("before_agent_start", (event, ctx) => {
			if (keep) return undefined;
			const { parts, dropped } = dropServerInstructions(event.systemPrompt);
			if (!dropped) return undefined;
			const d: Dropped = dropped;
			ledger.append({ event: "instructions", session: sessionOf(ctx), decision: "dropped", chars: d.chars, servers: d.servers, userAppendDropped: d.userAppendDropped });
			return { systemPrompt: parts };
		});
	};
}

export default createMcpInstructionsGuard();
