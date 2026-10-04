import type { Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Dash, Tick } from '../types'

/**
 * A live pane of the ai-loop (#275): `/ai-loop-dash` opens it, and while the
 * session lasts it re-runs `repo-ai loop dash --json` every `pollSeconds` and
 * draws the same sections as `renderDash` (src/cli/commands/loop-dash.ts).
 * Only numbers, label/arm names and the loop's own reasons are drawn — the
 * JSON carries no bodies.
 */

const PANE = 'ai-loop'
const TITLE = 'ai-loop'
const DEFAULT_POLL_SECONDS = 180
const MIN_POLL_SECONDS = 60
const dash = atom({ plugin: 'repo-ai', key: 'dash' } as const, {} as Dash)

type Row = Record<string, unknown>
const n = (x: unknown) => (x == null ? '' : `#${x}`)
const dim = (x: unknown) => (x ? `  ${x}` : '')

/** Same titles and rows as `renderDash`, in the same order. */
export const SECTIONS: [string, string, (x: Row) => string][] = [
	['pickups', 'pickups', (x) => `${n(x.number)}${x.stackedOn ? ` (on #${x.stackedOn})` : ''}`],
	['skippedPickups', 'skipped pickups', (x) => `${n(x.number)}${dim(x.reason)}`],
	['reviewsToSpawn', 'reviews to spawn', (x) => `${n(x.pr)}  ${x.arm}`],
	['fixRounds', 'fix rounds', (x) => `${n(x.pr)}  ${x.action} (${x.applications})${dim(x.reason)}`],
	[
		'handoffs',
		'handoffs',
		(x) => `${n(x.pr)}${x.autoMerge ? '  auto-merge' : ''}${x.notes ? '  notes' : ''}`,
	],
	['sendBacks', 'send backs', (x) => `${n(x.pr)}  ${x.reason} → ${x.label}`],
	['stalled', 'stalled', (x) => `${n(x.pr ?? x.issue)}  ${x.kind}${dim(x.label)}  ${x.action}`],
	['toClean', 'to clean', (x) => `${n(x.pr ?? x.issue)}  ${x.action}${dim(x.reason)}`],
	['updateBranches', 'update branches', (x) => n(x.pr)],
	['dependabotRecreate', 'dependabot recreate', (x) => n(x.pr)],
	['dependabotStalled', 'dependabot stalled', (x) => n(x.pr)],
]

const list = (t: Tick, key: string) => (Array.isArray(t[key]) ? (t[key] as Row[]) : [])
const strings = (t: Tick, key: string) => list(t, key).map(String)

export const register: Register = (on) => {
	let timer: { cancel: () => void } | undefined

	on('session.start', async ($, e, next) => {
		await $.command.register({
			name: 'ai-loop-dash',
			description: "Open a live pane of the ai-loop's state (repo-ai loop dash)",
		})
		return next(e)
	})

	on('command.run', { command: 'ai-loop-dash' }, async ($) => {
		const poll = async () => {
			try {
				const r = await $.process.run(['npx', '--no', 'repo-ai', 'loop', 'dash', '--json'], {
					timeoutMs: 120_000,
				})
				const tick = r.exitCode === 0 ? (JSON.parse(r.stdout) as Tick) : undefined
				const error = tick ? undefined : r.stderr.trim().split('\n').pop() || `exit ${r.exitCode}`
				await update($, dash, (d) => ({ tick: tick ?? d.tick, error }))
			} catch (err) {
				await update($, dash, (d) => ({ ...d, error: (err as Error).message }))
			}
		}
		if (!timer) {
			let seconds = DEFAULT_POLL_SECONDS
			try {
				const own = JSON.parse(String(await $.fs.read('.repo-ai.json'))).pollSeconds
				if (typeof own === 'number') seconds = Math.max(MIN_POLL_SECONDS, Math.floor(own))
			} catch {
				// no config: the default, as `loop dash` does
			}
			timer = await $.clock.every(seconds * 1000, poll)
			void poll()
		}
		await $.ui.open({ id: PANE, title: TITLE })
		return { text: 'ai-loop pane opened.' }
	})

	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
		const { Box, Text } = $.ui.resolve(e)
		const { tick: t, error } = await read($, dash)
		if (!t) {
			return (
				<Box flexDirection="column">
					<Text dimColor>{error ? `poll failed: ${error}` : 'Polling repo-ai loop dash…'}</Text>
				</Box>
			)
		}
		const sections = SECTIONS.map(([key, title, row]) => [title, list(t, key).map(row)] as const)
		const flags = ['releaseGated', 'releaseStuck', 'releaseFailed']
			.filter((f) => t[f])
			.map((f) => f.replace('release', 'release-').toLowerCase())
		const notes = [
			...strings(t, 'warnings').map((w) => `warn: ${w}`),
			...strings(t, 'staleInstall').map((s) => `stale install: ${s}`),
		]
		const errors = strings(t, 'errors').map((x) => `error: ${x}`)
		const empty =
			sections.every(([, rows]) => rows.length === 0) &&
			flags.length + notes.length + errors.length === 0

		return (
			<Box flexDirection="column">
				<Text bold>{`${t.summary}  agents ${t.liveAgents}/${t.liveAgents + t.slots}`}</Text>
				{t.halt && (
					<Text color="red" bold>
						⚠ halt: {t.halt}
					</Text>
				)}
				{error && <Text color="yellow">last poll failed: {error}</Text>}
				{sections
					.filter(([, rows]) => rows.length > 0)
					.map(([title, rows]) => (
						<Box flexDirection="column" key={title}>
							<Text color="cyan">
								{title} ({rows.length})
							</Text>
							{rows.map((r) => (
								<Text>{`  ${r}`}</Text>
							))}
						</Box>
					))}
				{flags.length > 0 && <Text color="yellow">{flags.join(' · ')}</Text>}
				{notes.map((x) => (
					<Text color="yellow">{x}</Text>
				))}
				{errors.map((x) => (
					<Text color="red">{x}</Text>
				))}
				{empty && <Text dimColor>nothing to do</Text>}
			</Box>
		)
	})
}
