import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import type { GhExec } from '../../../src/base/gh.js'
import { pickupSlug, runLoopApply } from '../../../src/cli/commands/loop-apply.js'
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
		maxTasksPerTick: 8,
		warnings: [],
	} as unknown as LoopEnv
	return { ...emptyTick(env), ...work }
}

/**
 * Records every write; `fail` names the gh subcommands (`pr update-branch`) that exit non-zero.
 * `labels` is each PR's current labels, as the pre-claim re-read sees them (#243).
 */
function fakeGh(
	fail: string[] = [],
	prs: Record<string, { number: number; state: string }> = {},
	labels: Record<number, string[]> = {}
) {
	const calls: string[][] = []
	const gh: GhExec = async (args) => {
		const ok = (stdout: string) => ({ ok: true, stdout, stderr: '', code: 0 })
		if (args[0] === 'pr' && args[1] === 'list') {
			const pr = prs[args[args.indexOf('--head') + 1] as string]
			return ok(JSON.stringify(pr ? [pr] : []))
		}
		if (args[0] === 'issue' && args[1] === 'view') return ok('OPEN\n')
		if (args[0] === 'pr' && args[1] === 'view')
			return ok(`${(labels[Number(args[2])] ?? []).join('\n')}\n`)
		calls.push(args)
		if (fail.includes(`${args[0]} ${args[1]}`))
			return { ok: false, stdout: '', stderr: 'boom', code: 1 }
		return ok(args[1]?.endsWith('/git/commits') ? 'new\n' : '')
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
// A conflict send-back keeps the pass and `ai-notes` (#217).
const KEEP_PASS = [
	'--add-label',
	'ai-ok-code',
	'--add-label',
	'ai-ok-sec',
	'--remove-label',
	'ai-review',
	'--remove-label',
	'merge-ready',
]

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
				['pr', 'edit', '14', '--add-label', 'ai-conflicts', ...KEEP_PASS],
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
			name: 'asks Dependabot to recreate and drops the stale verdicts (#240)',
			work: { dependabotRecreate: [{ pr: 15, head: 'abc' }] },
			calls: [
				['pr', 'comment', '15', '--body', '@dependabot recreate\n<!-- ai-loop:recreate:abc -->'],
				[
					'pr',
					'edit',
					'15',
					'--remove-label',
					'ai-ok-code',
					'--remove-label',
					'ai-ok-sec',
					'--remove-label',
					'merge-ready',
				],
			],
			errors: 0,
		},
		{
			name: 'hands a stalled Dependabot recreate to the human and drops its passes (#255)',
			work: { dependabotStalled: [{ pr: 15, head: 'abc' }] },
			calls: [
				[
					'pr',
					'edit',
					'15',
					'--add-assignee',
					'human',
					'--remove-assignee',
					'agent-bot',
					'--remove-label',
					'ai-ok-code',
					'--remove-label',
					'ai-ok-sec',
					'--remove-label',
					'merge-ready',
				],
				['pr', 'comment', '15', '--body', expect.stringContaining('<!-- ai-loop:stalled:abc -->')],
			],
			errors: 0,
		},
		{
			name: 'reruns a first-attempt ci-red run instead of spending a fix round (#202)',
			work: { rerunFailed: [{ pr: 10, issue: 1, runIds: [555, 666] }] },
			calls: [
				['run', 'rerun', '555', '--failed'],
				['run', 'rerun', '666', '--failed'],
			],
			errors: 0,
		},
		{
			name: 'resyncs a lagging PR head with a fast-forward empty commit (#219)',
			work: {
				resync: [{ pr: 10, issue: 1, branch: 'ai-1-stuck', sha: 'old', tree: 'tree' }],
			},
			calls: [
				[
					'api',
					'repos/acme/widget/git/commits',
					'-f',
					'message=chore: resync PR head [ai-loop]',
					'-f',
					'tree=tree',
					'-f',
					'parents[]=old',
					'--jq',
					'.sha',
				],
				['api', '-X', 'PATCH', 'repos/acme/widget/git/refs/heads/ai-1-stuck', '-f', 'sha=new'],
			],
			errors: 0,
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

describe('runLoopApply claims (#148)', () => {
	const fix = (pr: number, action: 'spawn' | 'block') => ({
		pr,
		issue: pr - 100,
		worktree: action === 'spawn' ? '/wt' : null,
		applications: action === 'spawn' ? 1 : 3,
		action,
		reason: 'r',
	})

	it('claims fixes first, then reviews, within maxTasksPerTick', async () => {
		const root = checkout(newTmpDir())
		const fake = fakeGh()
		const t = tick(root, {
			fixRounds: [fix(101, 'spawn')],
			reviewsToSpawn: [
				{ pr: 102, issue: 2, arm: 'both' },
				{ pr: 103, issue: 3, arm: 'code' },
			],
		})
		t.env.maxTasksPerTick = 2
		const r = await runLoopApply({ tick: t, gh: fake.gh })
		expect(fake.calls).toEqual([
			['pr', 'edit', '101', '--add-label', 'ai-fixing', '--add-assignee', 'agent-bot'],
			[
				'pr',
				'edit',
				'102',
				'--add-label',
				'ai-reviewing-code',
				'--add-label',
				'ai-reviewing-sec',
				'--add-assignee',
				'agent-bot',
			],
		])
		expect(r.claimed.fixes.map((f) => f.pr)).toEqual([101])
		expect(r.claimed.reviews.map((x) => x.pr)).toEqual([102])
	})

	it('skips a review arm that passed or was claimed since the tick (#243)', async () => {
		const root = checkout(newTmpDir())
		const fake = fakeGh([], {}, { 102: ['ai-review', 'ai-ok-code'], 103: ['ai-reviewing-sec'] })
		const t = tick(root, {
			reviewsToSpawn: [
				{ pr: 102, issue: 2, arm: 'both' },
				{ pr: 103, issue: 3, arm: 'sec' },
			],
		})
		const r = await runLoopApply({ tick: t, gh: fake.gh })
		expect(fake.calls).toEqual([
			['pr', 'edit', '102', '--add-label', 'ai-reviewing-sec', '--add-assignee', 'agent-bot'],
		])
		expect(r.claimed.reviews.map((x) => [x.pr, x.arm])).toEqual([[102, 'sec']])
	})

	it('blocks a round-capped fix round outside the cap and owes the comment', async () => {
		const root = checkout(newTmpDir())
		const fake = fakeGh()
		const t = tick(root, { fixRounds: [fix(104, 'block')] })
		t.env.maxTasksPerTick = 0
		const r = await runLoopApply({ tick: t, gh: fake.gh })
		expect(fake.calls).toEqual([
			[
				'issue',
				'edit',
				'4',
				'--add-label',
				'ai-blocked',
				'--remove-label',
				'ai-wip',
				'--add-assignee',
				'human',
				'--remove-assignee',
				'agent-bot',
			],
			[
				'pr',
				'edit',
				'104',
				'--remove-label',
				'ai-review',
				'--add-assignee',
				'human',
				'--remove-assignee',
				'agent-bot',
			],
		])
		expect(r.comments).toMatchObject([{ kind: 'round-cap', pr: 104 }])
		expect(r.claimed.fixes).toEqual([])
	})

	it('claims pickups up to slots, skipping one sharing a file, and adds each worktree', async () => {
		const root = checkout(newTmpDir())
		const fake = fakeGh()
		const pickups = [
			{ number: 21, title: 'feat(x): add the widget', body: 'touch `src/a.ts`' },
			{ number: 22, title: 'fix: other', body: 'also `lib/a.ts`' },
			{ number: 23, title: 'fix: third', body: '' },
			{ number: 24, title: 'fix: fourth', body: '' },
		]
		const r = await runLoopApply({ tick: tick(root, { pickups, slots: 2 }), gh: fake.gh })
		const claim = (n: number) => [
			'issue',
			'edit',
			String(n),
			'--add-label',
			'ai-wip',
			'--remove-label',
			'ai-ready',
			'--add-assignee',
			'agent-bot',
		]
		expect(fake.calls).toEqual([claim(21), claim(23)])
		expect(r.claimed.pickups).toMatchObject([
			{ number: 21, slug: 'ai-21-add-widget' },
			{ number: 23, slug: 'ai-23-third' },
		])
		for (const p of r.claimed.pickups) expect(fs.existsSync(p.worktree)).toBe(true)
		expect(r.errors).toEqual([])
	})

	it('returns the issue to ai-ready when its worktree fails', async () => {
		const root = checkout(newTmpDir())
		git(root, 'branch', 'ai-25-taken')
		const fake = fakeGh()
		const r = await runLoopApply({
			tick: tick(root, { pickups: [{ number: 25, title: 'taken', body: '' }], slots: 1 }),
			gh: fake.gh,
		})
		expect(fake.calls[1]).toEqual([
			'issue',
			'edit',
			'25',
			'--add-label',
			'ai-ready',
			'--remove-label',
			'ai-wip',
			'--remove-assignee',
			'agent-bot',
		])
		expect(r.claimed.pickups).toEqual([])
		expect(r.errors).toHaveLength(1)
	})

	it('slugs a title into up to four kebab words', () => {
		expect(pickupSlug(9, 'feat(loop)!: Loop apply takes the review, fix and pickup claims')).toBe(
			'ai-9-loop-apply-takes-review'
		)
		expect(pickupSlug(9, '!!!')).toBe('ai-9-issue')
	})
})

describe('runLoopApply stacking (#253)', () => {
	const retarget = { pr: 60, issue: 6, parent: 50, passed: false, body: 'b\nStacked on #50' }
	const edit = ['pr', 'edit', '60', '--base', 'main', '--body', 'b\nWas stacked on #50']

	it('retargets onto the default branch and merges it in', async () => {
		const fake = fakeGh()
		await runLoopApply({ tick: tick(checkout(newTmpDir()), { retarget: [retarget] }), gh: fake.gh })
		expect(fake.calls).toEqual([edit, ['pr', 'update-branch', '60']])
	})

	it('sends a conflicted retarget back as ai-conflicts without granting a pass', async () => {
		const fake = fakeGh(['pr update-branch'])
		await runLoopApply({ tick: tick(checkout(newTmpDir()), { retarget: [retarget] }), gh: fake.gh })
		expect(fake.calls[2]).toEqual([
			'pr',
			'edit',
			'60',
			'--add-label',
			'ai-conflicts',
			'--remove-label',
			'ai-review',
			'--remove-label',
			'merge-ready',
		])
	})

	it('branches a stacked pickup from its parent PR', async () => {
		const root = checkout(newTmpDir())
		git(root, 'push', '-q', 'origin', 'HEAD:ai-5-parent')
		git(root, 'fetch', '-q', 'origin')
		const pickups = [
			{ number: 6, title: 'feat: child', body: '', base: 'ai-5-parent', stackedOn: 50 },
		]
		const r = await runLoopApply({ tick: tick(root, { pickups, slots: 1 }), gh: fakeGh().gh })
		expect(r.errors).toEqual([])
		expect(r.claimed.pickups).toMatchObject([
			{ number: 6, slug: 'ai-6-child', base: 'ai-5-parent', stackedOn: 50 },
		])
	})
})
