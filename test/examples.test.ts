import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CONFIG_KEYS, loadConfig, resolveSettings } from "../src/config";
import { PACKAGE, removeCreated, tempDir } from "./helpers";

afterAll(removeCreated);

const EXAMPLES = path.join(PACKAGE, "examples");

describe("examples (AC-8)", () => {
	it("overlay.yml turns project MCP off and denies bash, eval, and the example MCP tool, as omp itself reads it", async () => {
		const dir = tempDir("mg-overlay-");
		const settings = await Settings.loadReadOnly({ cwd: dir, agentDir: path.join(dir, "agent"), configFiles: [path.join(EXAMPLES, "overlay.yml")] });
		expect(settings.get("mcp.enableProjectConfig")).toBe(false);
		expect(settings.get("tools.approval")).toMatchObject({ bash: "deny", eval: "deny", mcp__docs_delete_page: "deny" });
	});

	it("mcp.json lists servers with instructions off and a disabledServers list", () => {
		const config = JSON.parse(fs.readFileSync(path.join(EXAMPLES, "mcp.json"), "utf8")) as { mcpServers: Record<string, { instructions?: unknown }>; disabledServers: unknown };
		expect(Object.keys(config.mcpServers).length).toBeGreaterThan(0);
		for (const server of Object.values(config.mcpServers)) expect(server.instructions).toBe(false);
		expect(Array.isArray(config.disabledServers)).toBe(true);
	});

	it("config.example.json sets every setting, and the guard accepts it", () => {
		const config = loadConfig(path.join(EXAMPLES, "config.example.json"));
		expect(Object.keys(config).sort()).toEqual([...CONFIG_KEYS].sort());
		const resolved = resolveSettings(config);
		expect([...resolved.blockedServers]).toEqual(config.blockedServers ?? []);
	});
});
