import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot } from '../types'

const snapshot = atom({ plugin: 'repo-ai-rainbow', key: 'snapshot' } as const, null)

// The repo-ai pipeline in the order work flows through it, each with its color.
const LABELS = [
	{ label: 'ai-ready', icon: '●', color: '#22c55e' },
	{ label: 'ai-wip', icon: '◐', color: '#eab308' },
	{ label: 'ai-blocked', icon: '✖', color: '#ef4444' },
	{ label: 'ai-review', icon: '◎', color: '#06b6d4' },
	{ label: 'ai-changes', icon: '↻', color: '#f97316' },
	{ label: 'ai-ok-code', icon: '✔', color: '#3b82f6' },
	{ label: 'ai-ok-sec', icon: '⛨', color: '#d946ef' },
] as const

const LOOP_COLORS: Record<string, string> = {
	working: '#22c55e',
	idle: '#06b6d4',
	stopped: '#a1a1aa',
}

// ponytail: polls every 5 min; a gh webhook would be instant but needs a server.
const POLL_MS = 5 * 60 * 1000

export function age(seconds: number): string {
	if (seconds < 60) return `${seconds}s`
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
	return `${Math.floor(seconds / 86400)}d`
}

export function summary(s: Snapshot): string {
	const parts = LABELS.map(({ label }) => `${label} ${s.counts[label] ?? 0}`)
	if (s.loop) parts.push(`loop ${s.loop}${s.loopAge === null ? '' : ` (${age(s.loopAge)} ago)`}`)
	return parts.join(' · ')
}

async function gh($: EngineInterface, kind: 'issue' | 'pr'): Promise<string[][]> {
	const run = await $.process.run(
		['gh', kind, 'list', '--state', 'open', '--limit', '200', '--json', 'labels'],
		{ timeoutMs: 20_000 }
	)
	if (run.exitCode !== 0) throw new Error(run.stderr.trim() || `gh ${kind} list failed`)
	const items: { labels: { name: string }[] }[] = JSON.parse(run.stdout)
	return items.map((item) => item.labels.map((l) => l.name))
}

// .claude/ai-loop-status: line 1 is the state, line 4 the epoch seconds it was written.
async function loopStatus($: EngineInterface): Promise<Pick<Snapshot, 'loop' | 'loopAge'>> {
	try {
		const lines = (await $.fs.read('.claude/ai-loop-status')).split('\n')
		const stamp = Number(lines[3])
		const now = Math.floor((await $.clock.now()) / 1000)
		return { loop: lines[0]?.trim() || null, loopAge: stamp > 0 ? Math.max(0, now - stamp) : null }
	} catch {
		return { loop: null, loopAge: null }
	}
}

async function refresh($: EngineInterface): Promise<Snapshot | null> {
	try {
		const [issues, prs, loop] = await Promise.all([gh($, 'issue'), gh($, 'pr'), loopStatus($)])
		const counts: Record<string, number> = {}
		for (const names of [...issues, ...prs]) {
			for (const name of names) counts[name] = (counts[name] ?? 0) + 1
		}
		const fresh: Snapshot = { counts, ...loop }
		await update($, snapshot, () => fresh)
		return fresh
	} catch {
		// Not a GitHub repo, gh logged out, offline: hide the band rather than nag.
		await update($, snapshot, () => null)
		return null
	}
}

export const register: Register = (on) => {
	on('session.start', async ($, e, next) => {
		await $.command.register({
			name: 'repo-ai',
			description: 'Refresh the repo-ai pipeline band and print its counts',
		})
		void refresh($)
		$.clock.every(POLL_MS, () => refresh($))
		return next(e)
	})

	on('command.run', { command: 'repo-ai' }, async ($) => {
		const s = await refresh($)
		return { text: s ? summary(s) : 'repo-ai: no GitHub data here (is gh logged in?)' }
	})

	on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
		const s = await read($, snapshot)
		if (e.props.hasSurvey || s === null) return next(e)

		const { Box, Text } = $.ui.resolve(e)
		const loopKind = s.loop?.split('·')[0] ?? ''

		return (
			<Box>
				<Text bold color="#a855f7">
					repo-ai{' '}
				</Text>
				{LABELS.map(({ label, icon, color }) => {
					const n = s.counts[label] ?? 0
					return (
						<Text color={color} dimColor={n === 0} bold={n > 0}>
							{icon} {label.slice(3)} {n}
							{'  '}
						</Text>
					)
				})}
				{s.loop && (
					<Text color={LOOP_COLORS[loopKind] ?? '#f472b6'}>
						⟳ {s.loop}
						{s.loopAge === null ? '' : ` ${age(s.loopAge)}`}
					</Text>
				)}
			</Box>
		)
	})
}
