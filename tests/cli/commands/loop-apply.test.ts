import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import type { GhExec } from '../../../src/base/gh.js'
import { runLoopApply } from '../../../src/cli/commands/loop-apply.js'
import type { LoopEnv } from '../../../src/cli/commands/loop-env.js'
import { emptyTick, type LoopTickResult } from '../../../src/cli/commands/loop-tick.js'
import { useTmpDir } from '../../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
		.toString()
		.trim()

function checkout(parent: string): string {
	const origin = join(parent, 'origin.git')
	git(parent, 'init', '-q', '--bare', '-b', 'main', origin)
	const dir = join(parent, 'repo')
	git(parent, 'clone', '-q', origin, dir)
	git(dir, 'config', 'user.email', 'test@example.com')
	git(dir, 'config', 'user.name', 'Test')
	git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
	git(dir, 'push', '-q', 'origin', 'main')
	git(dir, 'remote', 'set-head', 'origin', '--auto')
	return fs.realpathSync(dir)
}

function tick(root: string, work: Partial<LoopTickResult>, users = true): LoopTickResult {
	const env = {
		root,
		worktreeRoot: `${root}-worktrees`,
		ownerRepo: 'acme/widget',
		defaultBranch: 'main',
		agentUser: users ? 'agent-bot' : '',
		humanUser: users ? 'human' : '',
		me: 'agent-bot',
		warnings: [],
	} as unknown as LoopEnv
	return { ...emptyTick(env), ...work }
}

/** Records every write; `fail` names the gh subcommands (`pr update-branch`) that exit non-zero. */
function fakeGh(fail: string[] = [], prs: Record<string, { number: number; state: string }> = {}) {
	const calls: string[][] = []
	const gh: GhExec = async (args) => {
		const ok = (stdout: string) => ({ ok: true, stdout, stderr: '', code: 0 })
		if (args[0] === 'pr' && args[1] === 'list') {
			const pr = prs[args[args.indexOf('--head') + 1] as string]
			return ok(JSON.stringify(pr ? [pr] : []))
		}
		if (args[0] === 'issue' && args[1] === 'view') return ok('OPEN\n')
		calls.push(args)
		if (fail.includes(`${args[0]} ${args[1]}`))
			return { ok: false, stdout: '', stderr: 'boom', code: 1 }
		return ok('')
	}
	return { gh, calls }
}

const handoff = { pr: 10, issue: 1, title: 't', notes: false, autoMerge: false }
const sendBack = {
	pr: 12,
	issue: 3,
	reason: 'ci-red' as const,
	label: 'ai-changes' as const,
	failing: [{ name: 'verify', link: 'l' }],
}
const stall = {
	issue: 5,
	pr: null,
	minutes: 50,
	applications: 1,
	worktree: null,
	reason: 'r',
} as const
const PASS = [
	'--remove-label',
	'ai-review',
	'--remove-label',
	'ai-ok-code',
	'--remove-label',
	'ai-ok-sec',
]
const SEND_BACK = [...PASS, '--remove-label', 'ai-notes', '--remove-label', 'merge-ready']

describe('runLoopApply transitions (#147)', () => {
	it.each<{
		name: string
		work: Partial<LoopTickResult>
		users?: boolean
		fail?: string[]
		calls: string[][]
		comments?: unknown[]
		errors?: number
	}>([
		{
			name: 'disarms auto-merge armed before both reviews',
			work: { disarm: [13] },
			calls: [['pr', 'merge', '13', '--disable-auto']],
		},
		{
			name: 'hands over: merge-ready, human assigned, pass labels and agent dropped',
			work: { handoffs: [handoff] },
			calls: [
				[
					'pr',
					'edit',
					'10',
					'--add-assignee',
					'human',
					'--add-label',
					'merge-ready',
					...PASS,
					'--remove-assignee',
					'agent-bot',
				],
			],
			comments: [],
		},
		{
			name: 'hands over with no assignee flags when neither user is set',
			work: { handoffs: [handoff] },
			users: false,
			calls: [['pr', 'edit', '10', '--add-label', 'merge-ready', ...PASS]],
		},
		{
			name: 'hands over an ai-notes PR, keeps ai-notes, and owes a comment',
			work: { handoffs: [{ ...handoff, notes: true }] },
			users: false,
			calls: [['pr', 'edit', '10', '--add-label', 'merge-ready', ...PASS]],
			comments: [{ kind: 'notes', pr: 10 }],
		},
		{
			name: 'merges only an autoMerge handoff',
			work: { handoffs: [{ ...handoff, autoMerge: true }] },
			users: false,
			calls: [
				['pr', 'edit', '10', '--add-label', 'merge-ready', ...PASS],
				['pr', 'merge', '10', '--squash', '--auto'],
			],
		},
		{
			name: 'never merges when the handoff edit failed',
			work: { handoffs: [{ ...handoff, autoMerge: true }] },
			users: false,
			fail: ['pr edit'],
			calls: [['pr', 'edit', '10', '--add-label', 'merge-ready', ...PASS]],
			errors: 1,
		},
		{
			name: 'strips a merge-ready that no longer holds',
			work: { stripMergeReady: [11] },
			calls: [['pr', 'edit', '11', '--remove-label', 'merge-ready']],
		},
		{
			name: 'updates a BEHIND branch',
			work: { updateBranches: [{ pr: 14, issue: 4 }] },
			calls: [['pr', 'update-branch', '14']],
			errors: 0,
		},
		{
			name: 'sends a failed branch update back as ai-conflicts',
			work: { updateBranches: [{ pr: 14, issue: 4 }] },
			fail: ['pr update-branch'],
			calls: [
				['pr', 'update-branch', '14'],
				['pr', 'edit', '14', '--add-label', 'ai-conflicts', ...SEND_BACK],
			],
			comments: [{ kind: 'send-back', pr: 14, sendBack: { reason: 'DIRTY' } }],
			errors: 0,
		},
		{
			name: 'sends back with the tick’s label and owes the why',
			work: { sendBacks: [sendBack] },
			calls: [['pr', 'edit', '12', '--add-label', 'ai-changes', ...SEND_BACK]],
			comments: [{ kind: 'send-back', pr: 12, sendBack }],
		},
		{
			name: 'relabels a closed ai-wip issue and hands an open one to the human',
			work: {
				toClean: [
					{
						path: '',
						issue: 7,
						branch: null,
						pr: null,
						prState: null,
						action: 'relabel',
						reason: 'r',
					},
				],
			},
			calls: [
				[
					'issue',
					'edit',
					'7',
					'--remove-label',
					'ai-wip',
					'--remove-assignee',
					'agent-bot',
					'--add-assignee',
					'human',
				],
			],
		},
		{
			name: 'drops a dead reviewer’s own claim',
			work: {
				stalled: [
					{ ...stall, kind: 'reviewer', pr: 20, label: 'ai-reviewing-sec', action: 'drop-label' },
				],
			},
			calls: [['pr', 'edit', '20', '--remove-label', 'ai-reviewing-sec']],
		},
		{
			name: 'blocks a dead implementer’s issue and owes the comment',
			work: { stalled: [{ ...stall, kind: 'implementer', label: 'ai-wip', action: 'block' }] },
			calls: [
				[
					'issue',
					'edit',
					'5',
					'--add-label',
					'ai-blocked',
					'--remove-label',
					'ai-wip',
					'--add-assignee',
					'human',
					'--remove-assignee',
					'agent-bot',
				],
			],
			comments: [{ kind: 'blocked', issue: 5 }],
		},
		{
			name: 'leaves an orphan worktree to the model',
			work: {
				stalled: [{ ...stall, kind: 'orphan', issue: 6, label: null, action: 'remove-worktree' }],
			},
			calls: [],
		},
	])('$name', async ({ work, users, fail, calls, comments, errors }) => {
		const root = checkout(newTmpDir())
		const fake = fakeGh(fail)
		const r = await runLoopApply({ tick: tick(root, work, users), gh: fake.gh })
		expect(fake.calls).toEqual(calls)
		if (comments) expect(r.comments).toMatchObject(comments)
		if (errors !== undefined) expect(r.errors).toHaveLength(errors)
		expect(r.exitCode).toBe(0)
	})

	it('writes nothing on a halted tick', async () => {
		const root = checkout(newTmpDir())
		const fake = fakeGh()
		const r = await runLoopApply({
			tick: { ...tick(root, { handoffs: [handoff] }), halt: 'bare', exitCode: 2 },
			gh: fake.gh,
		})
		expect(fake.calls).toEqual([])
		expect(r).toMatchObject({ halt: 'bare', exitCode: 2 })
	})

	it('removes what the tick reported, rebuilds, and relabels the issue (#149)', async () => {
		const root = checkout(newTmpDir())
		const wt = join(`${root}-worktrees`, 'ai-3-closed')
		git(root, 'worktree', 'add', '-q', wt, '-b', 'ai-3-closed')
		const fake = fakeGh([], { 'ai-3-closed': { number: 13, state: 'CLOSED' } })
		const r = await runLoopApply({
			tick: tick(root, {}, false),
			gh: fake.gh,
			install: async () => true,
		})
		expect(r).toMatchObject({
			removed: [{ issue: 3, action: 'removed' }],
			halt: null,
			errors: [],
			exitCode: 0,
		})
		expect(r.rebuild).not.toBe('not-requested')
		expect(fs.existsSync(wt)).toBe(false)
		expect(fake.calls).toEqual([['issue', 'edit', '3', '--remove-label', 'ai-wip']])
	})
})
