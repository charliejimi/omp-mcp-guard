import { afterAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { readProcessLog } from "../src/proclog";
import { removeCreated, tempDir, writeFile } from "./helpers";

afterAll(removeCreated);

const collision = (pid: number, name: string) => JSON.stringify({ timestamp: "t", level: "warn", pid, message: "MCP tool name collision; keeping stable winner", name, keptServer: "a", ignoredServer: "A" });
const failed = (pid: number, server: string) => JSON.stringify({ timestamp: "t", level: "error", pid, message: "MCP tool load failed", path: `mcp:${server}`, error: "x" });

describe("readProcessLog (A3)", () => {
	it("reads this pid's dated log and its rotations, and skips other pids, other messages, and broken lines", () => {
		const dir = tempDir("mg-proclog-");
		writeFile(path.join(dir, "omp.2026-10-13.77.log"), [collision(77, "mcp__a_x"), failed(77, "dead"), failed(78, "other"), "{broken", JSON.stringify({ pid: 77, message: "MCP tool loaded" })].join("\n"));
		writeFile(path.join(dir, "omp.2026-10-13.77.log.1"), collision(77, "mcp__a_y"));
		writeFile(path.join(dir, "omp.2026-10-13.771.log"), collision(771, "mcp__a_z"));
		writeFile(path.join(dir, "omp.2026-10-13.177.log"), collision(77, "mcp__a_w"));
		const facts = readProcessLog(dir, 77);
		expect(facts.collisions.map(c => c.name).sort()).toEqual(["mcp__a_x", "mcp__a_y"]);
		expect(facts.loadFailures).toEqual([{ server: "dead" }]);
		expect(facts.files).toBe(2);
	});

	it("reads only the last part of a large log", () => {
		const dir = tempDir("mg-proclog-");
		const filler = `${"x".repeat(1024)}\n`.repeat(3000);
		writeFile(path.join(dir, "omp.2026-10-13.88.log"), `${collision(88, "mcp__early_x")}\n${filler}${collision(88, "mcp__late_x")}\n`);
		const facts = readProcessLog(dir, 88);
		expect(facts.collisions.map(c => c.name)).toEqual(["mcp__late_x"]);
	});

	it("returns nothing for a missing folder", () => {
		expect(readProcessLog(path.join(tempDir("mg-proclog-"), "none"), 1)).toEqual({ collisions: [], loadFailures: [], files: 0 });
	});
});
