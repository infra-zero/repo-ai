import type { Item, LoopStatus } from '../types'

// Mirrors STALE_AFTER in statusline/ai-loop.sh (tests/mods/loop-watch.test.ts keeps them equal):
// older than this, the loop is dead.
const STALE_AFTER = 2100

// Titles, descriptions and errors reach the terminal through Ink and toasts: drop ESC/OSC
// sequences, then every other control and bidi character, so none can inject an escape.
// Mirrors src/base/sanitize.ts, which a mod installed on its own can't import.
export function clean(s: string): string {
	return (
		s
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
			.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, '')
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
			.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
	)
}

// File format (written by ai-loop Pass 5): line 1 summary, line 3 next-tick epoch seconds.
export function parseStatus(text: string, mtimeSec: number, nowSec: number): LoopStatus {
	const lines = text.split('\n')
	const summary = clean(lines[0] ?? '')
	if (!summary) return null
	const due = Number(lines[2])
	let next = ''
	if (lines[2] && Number.isInteger(due)) {
		const left = Math.ceil((due - nowSec) / 60)
		next = left > 0 ? `next ${left}m` : 'tick due'
	}
	return { summary, next, isStale: nowSec - mtimeSec >= STALE_AFTER }
}

type GhRow = { number: number; title: string; labels: { name: string }[] }

export function aiItems(kind: Item['kind'], rows: GhRow[]): Item[] {
	return rows
		.map((r) => ({
			kind,
			number: r.number,
			title: clean(r.title),
			labels: r.labels.map((l) => clean(l.name)).filter((n) => n.startsWith('ai-')),
		}))
		.filter((i) => i.labels.length > 0)
}

// Passed both reviewers, or still waiting on a human.
export function isMergeReady(i: Item) {
	return i.labels.includes('ai-ok-code') && i.labels.includes('ai-ok-sec')
}

// One short line for what a subagent's tool call is doing, for the dock.
export function describeCall(tool: string, input: Record<string, unknown>): string {
	const arg = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description
	if (typeof arg !== 'string') return tool
	const short = clean('file_path' in input ? (arg.split('/').pop() ?? arg) : arg)
	return `${tool} ${short.length > 32 ? `${short.slice(0, 31)}…` : short}`
}

const ICONS: Record<string, string> = {
	Explore: '🔍',
	Plan: '📐',
	'code-reviewer': '🧐',
	debugger: '🐛',
	teammate: '👥',
}
export function agentIcon(type: string) {
	return ICONS[type] ?? '🤖'
}
