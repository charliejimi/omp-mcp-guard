// Injection phrasings: the Day25 article's five, plus the shapes Invariant Labs published for MCP
// tool poisoning (as in the Day27 article's guard). Keyword patterns are a tripwire: they miss a
// reworded payload and flag text that merely quotes one.

export const PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
	{
		id: "ignore-instructions",
		re: /\b(ignore|disregard|forget)\b[^\n]{0,40}\b(previous|prior|above|earlier|all|your)\b[^\n]{0,20}\binstructions?\b/i,
	},
	{ id: "zh-ignore-instructions", re: /(忽略|無視|忘記|忘掉)[^\n]{0,20}(先前|之前|以上|上面|所有)[^\n]{0,10}(指示|指令)/ },
	{ id: "addressed-to-ai", re: /\b(note|message|instructions?)\s+(for|to)\s+(ai|llm)\s+(assistants?|agents?|models?)\b/i },
	{
		id: "reveal-secret",
		re: /\b(print|reveal|send|exfiltrate|leak)\b[^\n]{0,30}\b(api[ _-]?keys?|secrets?|passwords?|tokens?|credentials?)\b/i,
	},
	{ id: "zh-print-secret", re: /印出\s*(api[_-]?key|secret|password|token)/i },
	{ id: "important-tag", re: /<\s*important\s*>/i },
	{ id: "before-using-tool", re: /\bbefore\s+using\s+(this|any|the)\s+tools?\b/i },
	{ id: "hide-from-user", re: /\bdo\s+not\s+(tell|mention|inform|show)\b[^\n]{0,30}\buser\b/i },
	{ id: "sensitive-path", re: /(~|\$HOME)\/\.(ssh|aws|cursor|omp)\b|\bid_(rsa|ed25519)\b|\bmcp\.json\b/i },
];

export function matchPattern(text: string): string | null {
	for (const p of PATTERNS) if (p.re.test(text)) return p.id;
	return null;
}
