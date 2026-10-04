/**
 * Titles are attacker-controlled on a public repo. Before one is shown
 * anywhere: no control characters (terminal escapes, OSC 8 links), no bidi
 * overrides (text that reads differently than it is), one line, bounded.
 * HTML escaping is the page's job (it only ever sets `textContent`).
 */
export function safeText(s: string | null | undefined, max = 120): string {
	const clean = (s ?? '')
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
		.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
