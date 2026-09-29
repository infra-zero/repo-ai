import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it, vi } from 'vitest'
import type { GhExec } from '../../../src/base/gh.js'
import { runLoopGuard } from '../../../src/cli/commands/loop-guard.js'
import type { LoopTickResult } from '../../../src/cli/commands/loop-tick.js'
import {
	actionable,
	describeWork,
	ensureStatusExcluded,
	runLoopWatch,
} from '../../../src/cli/commands/loop-watch.js'
import { useTmpDir } from '../../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

const tick = (extra: Partial<LoopTickResult> = {}) =>
	({
		halt: null,
		errors: [],
		summary: 'idle',
		slots: 6,
		...Object.fromEntries(
			[
				'adopt',
				'disarm',
				'handoffs',
				'sendBacks',
				'rerunFailed',
				'stripMergeReady',
				'toClean',
				'stalled',
			]
				.concat(['decay', 'verdicts', 'reviewsToSpawn', 'fixRounds', 'pickups', 'updateBranches'])
				.map((k) => [k, []])
		),
		...extra,
	}) as unknown as LoopTickResult

async function watch(results: (LoopTickResult | Error)[]) {
	const lines: string[] = []
	const sleeps: number[] = []
	const queue = [...results]
	await runLoopWatch({
		root: newTmpDir(),
		polls: results.length,
		poll: async () => {
			const r = queue.shift()
			if (r instanceof Error) throw r
			return r as LoopTickResult
		},
		sleep: async (ms) => void sleeps.push(ms),
		write: (l) => lines.push(l),
		now: () => new Date(2026, 0, 1, 9, 5),
	})
	return { lines, sleeps }
}

const review = tick({ summary: '1rev', reviewsToSpawn: [{ pr: 7, issue: 3, arm: 'code' }] })

describe('runLoopWatch', () => {
	it('prints the first poll only when it has work, then only on change', async () => {
		expect((await watch([tick(), tick()])).lines).toEqual([])
		const { lines, sleeps } = await watch([
			review,
			review,
			tick({ summary: '1ready', handoffs: [{ pr: 7, issue: 3, notes: false, autoMerge: false }] }),
		])
		expect(lines).toEqual(['09:05  1rev  review #7', '09:05  1ready  handoff #7'])
		expect(sleeps).toEqual([180_000, 180_000])
	})

	it('wakes only on a gain, not a loss (#183)', async () => {
		const handoff7 = { pr: 7, issue: 3, notes: false, autoMerge: false }
		const handoff9 = { pr: 9, issue: 5, notes: false, autoMerge: false }
		const clean153 = {
			path: '/worktrees/153',
			issue: 153,
			branch: 'fix/153',
			pr: null,
			prState: null,
			action: 'to-remove' as const,
		}
		const oneHandoff = tick({ summary: '1ready', handoffs: [handoff7] })

		// An entry draining away prints nothing.
		expect((await watch([oneHandoff, tick({ summary: 'idle' })])).lines).toEqual([
			'09:05  1ready  handoff #7',
		])

		// An unchanged handoff next to a shrinking `toClean` prints nothing (the
		// reported bug: removing a leftover ai-wip label shrank `toClean` while an
		// already merge-ready PR kept re-appearing in `handoffs`).
		const withCleaned = tick({
			summary: '1ready·1cln',
			handoffs: [handoff7],
			toClean: [clean153],
		})
		expect((await watch([withCleaned, oneHandoff])).lines).toEqual([
			'09:05  1ready·1cln  handoff #7 · clean #153',
		])

		// A new handoff alongside the unchanged one still prints.
		expect(
			(await watch([oneHandoff, tick({ summary: '2ready', handoffs: [handoff7, handoff9] })])).lines
		).toEqual(['09:05  1ready  handoff #7', '09:05  2ready  handoff #7 #9'])
	})

	it('ignores a blocked fix round and a growing stall age', async () => {
		const blocked = (minutes: number) =>
			tick({
				summary: '⚠1blocked',
				fixRounds: [
					{ pr: 7, issue: 3, worktree: null, applications: 2, action: 'block', reason: 'cap' },
				],
				stalled: [
					{
						kind: 'implementer',
						issue: 4,
						pr: null,
						label: 'ai-wip',
						minutes,
						applications: 1,
						action: 'block',
						worktree: null,
						reason: `${minutes}min`,
					},
				],
			} as Partial<LoopTickResult>)
		expect((await watch([blocked(50), blocked(53), blocked(56)])).lines).toHaveLength(1)
	})

	it('prints a halt once, and survives a failed poll', async () => {
		const halt = tick({ halt: 'root is bare', exitCode: 1 })
		const erred = tick({ errors: ['gh pr list failed'] })
		const { lines } = await watch([halt, halt, new Error('boom'), erred, review, halt])
		expect(lines).toEqual([
			'09:05  ⚠halt: root is bare',
			'09:05  1rev  review #7',
			'09:05  ⚠halt: root is bare',
		])
	})

	it('reads pollSeconds from .repo-ai.json, floored at 60', async () => {
		const root = newTmpDir()
		fs.outputJsonSync(join(root, '.repo-ai.json'), { pollSeconds: 5 })
		const sleeps: number[] = []
		await runLoopWatch({
			root,
			polls: 2,
			poll: async () => tick(),
			sleep: async (ms) => void sleeps.push(ms),
			write: () => {},
		})
		expect(sleeps).toEqual([60_000])
	})

	it('warns once on an identity mismatch and keeps printing the work list (#82)', async () => {
		const root = newTmpDir()
		fs.ensureDirSync(join(root, '.git'))
		fs.outputJsonSync(join(root, '.repo-ai.json'), { agentUser: 'some-bot' })
		const gh: GhExec = async () => ({ ok: true, stdout: 'the-owner\n', stderr: '', code: 0 })
		const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
		const lines: string[] = []
		await runLoopWatch({
			root,
			polls: 2,
			gh,
			// The real guard, against the gh the tick would get.
			poll: async (tickGh) => {
				const g = await runLoopGuard({ root, git: async () => 'true', gh: tickGh })
				return g.exitCode === 0 ? review : tick({ halt: g.messages.join('; '), exitCode: 2 })
			},
			sleep: async () => {},
			write: (l) => lines.push(l),
			now: () => new Date(2026, 0, 1, 15, 42),
		})
		expect(lines).toEqual(['15:42  1rev  review #7'])
		expect(warn).toHaveBeenCalledTimes(1)
		expect(String(warn.mock.calls[0][0])).toContain('agentUser is some-bot')
		warn.mockRestore()
	})
})

describe('status file summary (#114)', () => {
	async function watchStatus(root: string, results: LoopTickResult[]) {
		const writes: string[] = []
		await runLoopWatch({
			root,
			polls: results.length,
			poll: async () => results.shift() as LoopTickResult,
			sleep: async () => {},
			write: () => {},
			now: () => new Date(NOW * 1000),
			writeStatus: (file, text) => {
				writes.push(text)
				fs.writeFileSync(file, text)
			},
		})
		return writes
	}
	const statusFile = (root: string) => join(root, '.claude', 'ai-loop-status')
	const NOW = 1790000500

	it('rewrites line 1 only when the summary changes, keeping lines 2 and 3 and stamping line 4', async () => {
		const root = newTmpDir()
		fs.outputFileSync(statusFile(root), '1wip·1rev\n12 13\n1790000000\n1789990000\n')
		const writes = await watchStatus(root, [tick({ summary: 'idle' }), tick({ summary: 'idle' })])
		expect(writes).toEqual([`idle\n12 13\n1790000000\n${NOW}\n`])
	})

	it('does not write, so keeps line 4, when the summary already matches', async () => {
		const root = newTmpDir()
		fs.outputFileSync(statusFile(root), 'idle\n\n1790000000\n1789990000\n')
		expect(await watchStatus(root, [tick({ summary: 'idle' })])).toEqual([])
		expect(fs.readFileSync(statusFile(root), 'utf8').split('\n')[3]).toBe('1789990000')
	})

	it('writes ⚠halt on a halt', async () => {
		const root = newTmpDir()
		fs.outputFileSync(statusFile(root), 'idle\n4\n1790000000\n')
		const writes = await watchStatus(root, [tick({ halt: 'root is bare', exitCode: 1 })])
		expect(writes).toEqual([`⚠halt\n4\n1790000000\n${NOW}\n`])
	})

	it('creates a missing file only when .claude/ exists', async () => {
		const bare = newTmpDir()
		expect(await watchStatus(bare, [tick()])).toEqual([])
		expect(fs.existsSync(join(bare, '.claude'))).toBe(false)
		const root = newTmpDir()
		fs.ensureDirSync(join(root, '.claude'))
		expect(await watchStatus(root, [tick()])).toEqual([`idle\n\n\n${NOW}\n`])
	})

	it('does not write when the read fails for a reason other than ENOENT', async () => {
		const root = newTmpDir()
		fs.ensureDirSync(statusFile(root)) // a directory: readFileSync throws EISDIR
		const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
		expect(await watchStatus(root, [tick()])).toEqual([])
		expect(String(warn.mock.calls[0][0])).toContain('status read failed')
		warn.mockRestore()
	})
})

describe('describeWork', () => {
	it('lists only non-empty categories, by number', () => {
		const w = actionable(
			tick({
				reviewsToSpawn: [
					{ pr: 78, issue: 1, arm: 'code' },
					{ pr: 78, issue: 1, arm: 'sec' },
				],
				updateBranches: [{ pr: 74, issue: 2 }],
				pickups: [
					{ number: 39, title: 'x', body: 'untrusted' },
					{ number: 41, title: 'y', body: 'untrusted' },
				],
				stalled: [{ issue: 55, pr: null, label: 'ai-wip', action: 'block' }],
			} as Partial<LoopTickResult>)
		)
		expect(describeWork('5wip·1rev', w, new Date(2026, 0, 1, 15, 42))).toBe(
			'15:42  5wip·1rev  review #78 · update #74 · pickup #39 #41 · stalled #55'
		)
	})
})

describe('ensureStatusExcluded (#228)', () => {
	const gitRepo = () => {
		const root = newTmpDir()
		execFileSync('git', ['init', '-q', root])
		return { root, exclude: join(root, '.git', 'info', 'exclude') }
	}
	const lines = (f: string) => fs.readFileSync(f, 'utf8').split('\n')

	it('adds the entry when missing, keeping existing lines', () => {
		const { root, exclude } = gitRepo()
		fs.outputFileSync(exclude, 'foo')
		ensureStatusExcluded(root)
		expect(lines(exclude)).toEqual(['foo', '.claude/ai-loop-status', ''])
	})

	it('does not duplicate an existing entry', () => {
		const { root, exclude } = gitRepo()
		ensureStatusExcluded(root)
		ensureStatusExcluded(root)
		expect(lines(exclude).filter((l) => l === '.claude/ai-loop-status')).toHaveLength(1)
	})

	it('creates info/exclude when absent', () => {
		const { root, exclude } = gitRepo()
		fs.removeSync(join(root, '.git', 'info'))
		ensureStatusExcluded(root)
		expect(fs.readFileSync(exclude, 'utf8')).toBe('.claude/ai-loop-status\n')
	})

	it('ignores a non-git directory', () => {
		expect(() => ensureStatusExcluded(newTmpDir())).not.toThrow()
	})
})
