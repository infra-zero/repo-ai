import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Snapshot } from '../types'
import { agentIcon, aiItems, describeCall, isMergeReady, parseStatus } from './parse'

const PANE = 'loop-watch'
const snapshot = atom({ plugin: 'loop-watch', key: 'snapshot' } as const, null)
// agentId → its latest tool call, for the dock.
const activity = atom({ plugin: 'loop-watch', key: 'activity' } as const, {})

const LOCAL_MS = 5_000
const GH_MS = 120_000

let statusFile = ''
let items: Item[] = []
let ghError: string | undefined
// PR numbers already seen merge-ready; null until the first fetch, which seeds it silently.
let seenReady: Set<number> | null = null

async function refreshGh($: EngineInterface) {
	const fields = ['--state', 'open', '--limit', '100', '--json', 'number,title,labels']
	try {
		const [prs, issues] = await Promise.all([
			$.process.run(['gh', 'pr', 'list', ...fields]),
			$.process.run(['gh', 'issue', 'list', ...fields]),
		])
		if (prs.exitCode || issues.exitCode) {
			ghError = (prs.stderr || issues.stderr).trim().split('\n')[0]
			return
		}
		items = [
			...aiItems('pr', JSON.parse(prs.stdout)),
			...aiItems('issue', JSON.parse(issues.stdout)),
		]
		ghError = undefined
		const ready = items.filter((i) => i.kind === 'pr' && isMergeReady(i))
		const seen = seenReady
		const fresh = seen ? ready.filter((i) => !seen.has(i.number)) : []
		seenReady = new Set(ready.map((i) => i.number))
		for (const pr of fresh) $.ui.toast(`✅ PR #${pr.number} ready to merge: ${pr.title}`)
		if (fresh.length) void $.audio.play({ asset: 'sounds/ready.wav' }).catch(() => {})
	} catch (err) {
		ghError = String(err)
	}
}

async function refresh($: EngineInterface) {
	const nowMs = await $.clock.now()
	let loop: Snapshot['loop'] = null
	try {
		const [text, stat] = await Promise.all([$.fs.read(statusFile), $.fs.stat(statusFile)])
		loop = parseStatus(text, stat.mtimeMs / 1000, nowMs / 1000)
	} catch {
		// ponytail: no status file = loop never ran here
	}
	const agents = (await $.agent.list())
		.filter((a) => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
		.map((a) => ({ id: a.id, type: a.type, description: a.description, status: a.status }))
	await update($, snapshot, () => ({ loop, items, agents, ghError, updatedAt: nowMs }))

	const parts: string[] = []
	if (loop && !loop.isStale) parts.push(`🤖 ${loop.summary}${loop.next ? ` · ${loop.next}` : ''}`)
	if (agents.length) parts.push(`${agents.length} agent${agents.length > 1 ? 's' : ''}`)
	const ready = items.filter(isMergeReady).length
	if (ready) parts.push(`${ready} ready to merge`)
	const blocked = items.filter((i) => i.labels.includes('ai-blocked')).length
	if (blocked) parts.push(`${blocked} blocked`)
	$.ui.status(parts.length ? parts.join(' · ') : undefined)
}

export const register: Register = (on) => {
	on('session.start', async ($, e, next) => {
		// The loop writes to the main checkout; from a worktree, find it via the shared git dir.
		const git = await $.process.run([
			'git',
			'rev-parse',
			'--path-format=absolute',
			'--git-common-dir',
		])
		const root = git.exitCode === 0 ? git.stdout.trim().replace(/\/\.git\/?$/, '') : e.cwd
		statusFile = `${root}/.claude/ai-loop-status`

		await $.command.register({
			name: 'loop-watch',
			description: 'Show ai-loop + agent activity in a pane',
		})
		void refreshGh($).then(() => refresh($))
		$.clock.every(LOCAL_MS, () => void refresh($))
		$.clock.every(GH_MS, () => void refreshGh($).then(() => refresh($)))
		return next(e)
	})

	on('command.run', { command: 'loop-watch' }, async ($) => {
		await refreshGh($)
		await refresh($)
		await $.ui.open({ id: PANE, title: 'ai-loop' })
		return { text: 'ai-loop pane opened.' }
	})

	// Dock: remember each subagent's latest tool call.
	on('tool.call', async ($, e, next) => {
		const id = e.agentId
		if (id) {
			const line = describeCall(e.tool, e as unknown as Record<string, unknown>)
			await update($, activity, (all) => ({ ...all, [id]: line }))
		}
		return next(e)
	})

	// Dock: one tile per live agent above the prompt; nothing when none run.
	on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
		const s = await read($, snapshot)
		if (e.props.hasSurvey || !s?.agents.length) return next(e)
		const doing = await read($, activity)
		const { Box, Text } = $.ui.resolve(e)
		return (
			<Box flexDirection="row" flexWrap="wrap">
				{s.agents.map((a, i) => (
					<Text key={a.id}>
						{i > 0 && <Text dimColor> │ </Text>}
						{agentIcon(a.type)} <Text color={a.status === 'running' ? 'green' : 'yellow'}>●</Text>{' '}
						<Text bold>{a.description.slice(0, 24)}</Text>{' '}
						<Text dimColor>{doing[a.id] ?? a.type}</Text>
					</Text>
				))}
			</Box>
		)
	})

	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
		const { Box, Text } = $.ui.resolve(e)
		const s = await read($, snapshot)
		if (!s) return <Text dimColor>Loading…</Text>
		const prs = s.items.filter((i) => i.kind === 'pr')
		const issues = s.items.filter((i) => i.kind === 'issue')
		const row = (i: Item) => (
			<Text
				key={`${i.kind}${i.number}`}
				color={isMergeReady(i) ? 'green' : i.labels.includes('ai-blocked') ? 'red' : undefined}
			>
				#{i.number} {i.title.slice(0, 50)} <Text dimColor>[{i.labels.join(' ')}]</Text>
			</Text>
		)
		return (
			<Box flexDirection="column">
				<Text bold>Loop</Text>
				{s.loop ? (
					<Text dimColor={s.loop.isStale}>
						{s.loop.summary}
						{s.loop.next && ` · ${s.loop.next}`}
						{s.loop.isStale && ' (stale)'}
					</Text>
				) : (
					<Text dimColor>No ai-loop status here.</Text>
				)}
				<Text bold>Agents ({s.agents.length})</Text>
				{s.agents.length === 0 && <Text dimColor>None running.</Text>}
				{s.agents.map((a) => (
					<Text key={a.id}>
						{a.status === 'running' ? '▶' : '…'} {a.type} <Text dimColor>{a.description}</Text>
					</Text>
				))}
				<Text bold>PRs ({prs.length})</Text>
				{prs.map(row)}
				<Text bold>Issues ({issues.length})</Text>
				{issues.map(row)}
				{s.ghError && <Text color="red">gh: {s.ghError}</Text>}
			</Box>
		)
	})
}
