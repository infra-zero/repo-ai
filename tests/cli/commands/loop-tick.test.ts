import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import type { GhExec } from '../../../src/base/gh.js'
import {
	isDocsOnly,
	problemLines,
	runLoopTick,
	staleInstall,
} from '../../../src/cli/commands/loop-tick.js'
import {
	PLUGIN_NAME,
	readShippedSkill,
	SHIPPED_SKILLS,
	stampSkill,
} from '../../../src/cli/generators/claude-skills.js'
import {
	readShippedWorkflow,
	SHIPPED_WORKFLOWS,
	stampWorkflow,
} from '../../../src/cli/generators/workflows.js'
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
	// The bare origin is empty at clone time, so `clone` never set origin/HEAD on its own.
	git(dir, 'remote', 'set-head', 'origin', '--auto')
	return fs.realpathSync(dir)
}

const NOW = new Date('2026-06-01T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

const pr = (
	number: number,
	head: string,
	labels: string[],
	extra: Partial<{ autoMergeRequest: unknown; author: string; body: string; title: string }> = {}
) => ({
	number,
	title: extra.title ?? `pr-${number}`,
	headRefName: head,
	labels: labels.map((name) => ({ name })),
	autoMergeRequest: extra.autoMergeRequest ?? null,
	author: { login: extra.author ?? 'me-bot' },
	body: extra.body ?? '',
	statusCheckRollup: [],
})

interface World {
	prs?: ReturnType<typeof pr>[]
	/** Open ai-wip issues: a number, or `{ number, body }` when the body matters. */
	wip?: (number | { number: number; body: string })[]
	/** Closed issues still labelled ai-wip. */
	closedWip?: number[]
	suggested?: { number: number; updatedAt: string; labels: { name: string }[] }[]
	queue?: unknown[]
	/** Overrides `queue`, spread across more than one `--slurp` page. */
	queuePages?: unknown[][]
	merge?: Record<number, string>
	failing?: number[]
	/** A failing PR's check `link` names this workflow run id, instead of the default unparseable `'l'`. */
	runIds?: Record<number, number>
	/** That run id's `run_attempt`, from `repos/…/actions/runs/<id>` (#202). */
	runAttempts?: Record<number, number>
	/** PRs whose required checks are still running. */
	pending?: number[]
	/** PRs with no required check reported yet (`gh pr checks --required` is empty). */
	unreported?: number[]
	/** PR → [arm, verdict] markers posted on the current head. */
	reviews?: Record<number, [string, string][]>
	changes?: Record<number, number>
	/** PR → `gh pr diff --name-only`. */
	diffs?: Record<number, string[]>
	/** The `release` environment carries `required_reviewers`. */
	gated?: boolean
	/** The latest main push run of ci.yml was cancelled with no jobs (#153). */
	ciCancelled?: boolean
	/** A main push run of ci.yml has sat waiting on `release` approval past 24h (#146). */
	releaseWaiting?: boolean
	/** Open Dependabot alert severities (#203). */
	securityAlerts?: string[]
	/** The newest completed main push run's `release` job failed (#204). */
	releaseFailed?: boolean
}

function fakeGh(w: World): GhExec {
	return async (args) => {
		const ok = (v: unknown) => ({
			ok: true,
			stdout: typeof v === 'string' ? v : JSON.stringify(v),
			stderr: '',
		})
		const [a, b] = args
		if (a === 'repo') return ok('acme/widget\n')
		if (a === 'api') {
			if (b === 'user') return ok('me-bot\n')
			if (b === 'repos/acme/widget') return ok('acme\n')
			if (b === 'repos/acme/widget/environments')
				return ok({
					environments: w.gated
						? [{ name: 'release', protection_rules: [{ type: 'required_reviewers' }] }]
						: [],
				})
			if (b === 'repos/acme/widget/assignees/agent-bot') return ok('')
			if (b?.startsWith('repos/acme/widget/actions/workflows/ci.yml/runs?'))
				return ok({
					workflow_runs: w.ciCancelled
						? [
								{
									id: 9,
									status: 'completed',
									conclusion: 'cancelled',
									html_url: 'https://github.com/acme/widget/actions/runs/9',
									created_at: NOW.toISOString(),
									path: '.github/workflows/ci.yml',
								},
							]
						: w.releaseWaiting
							? [
									{
										id: 9,
										status: 'waiting',
										conclusion: null,
										html_url: 'https://github.com/acme/widget/actions/runs/9',
										created_at: new Date(NOW.getTime() - 25 * 3_600_000).toISOString(),
										path: '.github/workflows/ci.yml',
									},
								]
							: w.releaseFailed
								? [
										{
											id: 9,
											status: 'completed',
											conclusion: 'failure',
											html_url: 'https://github.com/acme/widget/actions/runs/9',
											created_at: NOW.toISOString(),
											path: '.github/workflows/ci.yml',
										},
									]
								: [],
				})
			if (b === 'repos/acme/widget/actions/runs/9/jobs?per_page=1') return ok({ total_count: 0 })
			if (b?.startsWith('repos/acme/widget/dependabot/alerts?'))
				return ok([
					(w.securityAlerts ?? []).map((severity) => ({ security_vulnerability: { severity } })),
				])
			const runMatch = b?.match(/^repos\/acme\/widget\/actions\/runs\/(\d+)$/)
			if (runMatch) return ok({ run_attempt: w.runAttempts?.[Number(runMatch[1])] ?? 1 })
			if (b === 'repos/acme/widget/actions/runs/9/jobs?per_page=100')
				return ok({ jobs: w.releaseFailed ? [{ name: 'release', conclusion: 'failure' }] : [] })
			if (b?.startsWith('repos/acme/widget/issues?')) return ok(w.queuePages ?? [w.queue ?? []])
			const timeline = b?.match(/issues\/(\d+)\/timeline/)
			if (timeline) {
				const n = Number(timeline[1])
				return ok(
					Array.from({ length: w.changes?.[n] ?? 0 }, () => `ai-changes\t${daysAgo(1)}`).join('\n')
				)
			}
			const reviews = b?.match(/pulls\/(\d+)\/reviews/)
			if (reviews) {
				const markers = w.reviews?.[Number(reviews[1])] ?? []
				return ok([
					markers.map(([arm, v]) => ({
						id: 1,
						user: { login: 'me-bot' },
						commit_id: 'head',
						body: `<!-- ai-issue-loop:verdict:${arm}:${v} -->`,
					})),
				])
			}
		}
		if (a === 'issue' && args.includes('ai-wip'))
			return ok(
				(args.includes('closed') ? (w.closedWip ?? []) : (w.wip ?? [])).map((i) =>
					typeof i === 'number' ? { number: i } : i
				)
			)
		if (a === 'issue' && args.includes('ai-suggested')) return ok(w.suggested ?? [])
		if (a === 'pr' && b === 'list') return ok(args.includes('--head') ? [] : (w.prs ?? []))
		if (a === 'pr' && b === 'checks') {
			const n = Number(args[2])
			const failing = w.failing?.includes(n)
			const pending = w.pending?.includes(n)
			const unreported = w.unreported?.includes(n)
			const runId = w.runIds?.[n]
			const failLink = runId ? `https://github.com/acme/widget/actions/runs/${runId}/job/1` : 'l'
			return {
				ok: !failing && !pending && !unreported,
				stdout: JSON.stringify(
					failing
						? [{ name: 'test', state: 'FAILURE', bucket: 'fail', link: failLink }]
						: pending
							? [{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending', link: 'l' }]
							: unreported
								? []
								: [{ name: 'verify', state: 'SUCCESS', bucket: 'pass', link: 'l' }]
				),
				stderr: '',
			}
		}
		if (a === 'pr' && b === 'diff') {
			const files = w.diffs?.[Number(args[2])]
			return files ? ok(`${files.join('\n')}\n`) : { ok: false, stdout: '', stderr: 'no diff' }
		}
		if (a === 'pr' && b === 'view') {
			if (args.includes('headRefOid')) return ok('head\n')
			return ok({ mergeStateStatus: w.merge?.[Number(args[2])] ?? 'UNKNOWN' })
		}
		return { ok: false, stdout: '', stderr: `unexpected gh ${args.join(' ')}` }
	}
}

describe('runLoopTick', () => {
	it('halts when the checkout cannot be resolved', async () => {
		const gh: GhExec = async () => ({ ok: false, stdout: '', stderr: 'no' })
		const r = await runLoopTick({ root: newTmpDir(), gh, env: {} })
		expect(r.exitCode).toBe(1)
		expect(r.halt).toBeTruthy()
	})

	it('is idle on a quiet repo', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({ root, gh: fakeGh({}), env: {}, now: NOW })
		expect(r).toMatchObject({ idle: true, summary: 'idle', exitCode: 0, errors: [] })
	})

	it('warns when the latest main push run was cancelled with no jobs (#153)', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({ root, gh: fakeGh({ ciCancelled: true }), env: {}, now: NOW })
		expect(r.warnings).toEqual([expect.stringContaining('runs/9')])
	})

	it('warns when a release run has waited on approval past 24h (#146)', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({ root, gh: fakeGh({ releaseWaiting: true }), env: {}, now: NOW })
		expect(r.releaseStuck).toBe(true)
		expect(r.warnings).toContainEqual(expect.stringContaining('waiting on approval'))
	})

	it('warns on an open high security alert, but not moderate-only (#203)', async () => {
		const root = checkout(newTmpDir())
		const high = await runLoopTick({
			root,
			gh: fakeGh({ securityAlerts: ['high'] }),
			env: {},
			now: NOW,
		})
		expect(high.warnings).toContainEqual(expect.stringContaining('open security alerts (1 high)'))

		const moderate = await runLoopTick({
			root,
			gh: fakeGh({ securityAlerts: ['moderate'] }),
			env: {},
			now: NOW,
		})
		expect(moderate.warnings).toEqual([])
	})

	it('adds ⚠release-stuck to a non-idle summary (#146)', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({
			root,
			gh: fakeGh({ closedWip: [1], releaseWaiting: true }),
			env: {},
			now: NOW,
		})
		expect(r.summary).toContain('⚠release-stuck')
	})

	it('warns when the newest completed run has a failed release job (#204)', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({ root, gh: fakeGh({ releaseFailed: true }), env: {}, now: NOW })
		expect(r.releaseFailed).toBe(true)
		expect(r.warnings).toContainEqual(expect.stringContaining('release failed'))
	})

	it('adds ⚠release-failed to a non-idle summary (#204)', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({
			root,
			gh: fakeGh({ closedWip: [1], releaseFailed: true }),
			env: {},
			now: NOW,
		})
		expect(r.summary).toContain('⚠release-failed')
	})

	it('reports a closed issue still labelled ai-wip, and is not idle (#23)', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({ root, gh: fakeGh({ closedWip: [1] }), env: {}, now: NOW })
		expect(r.idle).toBe(false)
		expect(r.toClean).toEqual([expect.objectContaining({ issue: 1, action: 'relabel', path: '' })])
	})

	it('reports a closed PR worktree in toClean without removing it (#149)', async () => {
		const root = checkout(newTmpDir())
		const wt = `${root}-worktrees/ai-7-done`
		git(root, 'worktree', 'add', '-q', wt, '-b', 'ai-7-done')
		const calls: string[][] = []
		const world = fakeGh({})
		const gh: GhExec = async (args, stdin) =>
			args.includes('ai-7-done')
				? { ok: true, stdout: JSON.stringify([{ number: 70, state: 'CLOSED' }]), stderr: '' }
				: world(args, stdin)
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh,
			git: async (args) => {
				calls.push(args)
				try {
					return git(root, ...args)
				} catch {
					return null
				}
			},
		})
		expect(r.toClean).toEqual([
			expect.objectContaining({ issue: 7, pr: 70, action: 'to-remove', path: wt }),
		])
		expect(fs.existsSync(wt)).toBe(true)
		expect(calls.filter(([a, b]) => a === 'worktree' || (a === 'branch' && b === '-D'))).toEqual([])
	})

	it('turns label state into one work list', async () => {
		const root = checkout(newTmpDir())
		await fs.ensureDir(`${root}-worktrees/ai-6-fix`)
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({
				wip: [1, 2, 6],
				prs: [
					pr(10, 'ai-1-ready', ['ai-review', 'ai-ok-code', 'ai-ok-sec', 'ai-notes']),
					pr(11, 'ai-2-behind', ['merge-ready']),
					pr(12, 'ai-3-red', ['ai-review']),
					pr(13, 'ai-4-review', ['ai-review', 'ai-ok-sec'], { autoMergeRequest: {} }),
					pr(14, 'ai-5-adopt-code', ['ai-review']),
					pr(15, 'ai-6-fix', ['ai-changes']),
					pr(16, 'ai-7-capped', ['ai-changes']),
					pr(17, 'fix/by-agent', [], { body: '🤖 *Opened by an agent.*' }),
					pr(18, 'fix/by-hand', [], { body: 'hand-written' }),
					pr(19, 'dependabot/npm/x', ['ai-changes']),
				],
				merge: { 10: 'CLEAN', 11: 'BEHIND' },
				failing: [12],
				reviews: { 14: [['code', 'PASS']] },
				changes: { 15: 1, 16: 3 },
				suggested: [
					{ number: 30, updatedAt: daysAgo(31), labels: [{ name: 'ai-suggested' }] },
					{ number: 31, updatedAt: daysAgo(1), labels: [{ name: 'ai-suggested' }] },
					{
						number: 32,
						updatedAt: daysAgo(40),
						labels: [{ name: 'ai-suggested' }, { name: 'ai-ready' }],
					},
				],
				queue: [
					{ number: 40, title: 'ok', body: 'b', labels: [], author_association: 'OWNER' },
					{ number: 41, title: 'stranger', body: '', labels: [], author_association: 'NONE' },
					{
						number: 42,
						title: 'held',
						body: '',
						labels: [{ name: 'holding' }],
						author_association: 'OWNER',
					},
					{
						number: 43,
						title: 'pr',
						body: '',
						labels: [],
						author_association: 'OWNER',
						pull_request: {},
					},
				],
			}),
		})

		expect(r.exitCode).toBe(0)
		expect(r.errors).toEqual([])
		expect(r.handoffs).toEqual([
			{ pr: 10, issue: 1, title: 'pr-10', notes: true, autoMerge: false },
		])
		expect(r.updateBranches).toEqual([{ pr: 11, issue: 2 }])
		expect(r.sendBacks).toEqual([
			{
				pr: 12,
				issue: 3,
				reason: 'ci-red',
				label: 'ai-changes',
				failing: [{ name: 'test', link: 'l' }],
			},
		])
		expect(r.disarm).toEqual([13])
		expect(r.verdicts).toEqual([{ pr: 14, arm: 'code', verdict: 'PASS' }])
		expect(r.reviewsToSpawn).toEqual([
			{ pr: 13, issue: 4, arm: 'code' },
			{ pr: 14, issue: 5, arm: 'sec' },
		])
		expect(r.fixRounds.map((f) => [f.pr, f.action])).toEqual([
			[15, 'spawn'],
			[16, 'block'],
		])
		expect(r.fixRounds[0]?.worktree).toBe(`${root}-worktrees/ai-6-fix`)
		expect(r.adopt).toEqual([17])
		expect(r.decay).toEqual([30])
		expect(r.pickups.map((p) => p.number)).toEqual([40])
		expect(r.slots).toBe(3)
		expect(r.idle).toBe(false)
		expect(r.summary).toBe('⚠1blocked·⚠1ci-red·5 agents·1 on CI·1 to merge')
	})

	it('takes maxInFlight and maxFixRounds from .repo-ai.json (#158)', async () => {
		const tick = async (config?: object) => {
			const root = checkout(newTmpDir())
			if (config) fs.outputJsonSync(`${root}/.repo-ai.json`, config)
			await fs.ensureDir(`${root}-worktrees/ai-7-capped`)
			return runLoopTick({
				root,
				env: {},
				now: NOW,
				gh: fakeGh({
					wip: [1],
					prs: [pr(16, 'ai-7-capped', ['ai-changes'])],
					changes: { 16: 3 },
				}),
			})
		}
		const defaults = await tick()
		expect(defaults.slots).toBe(5)
		expect(defaults.fixRounds.map((f) => f.action)).toEqual(['block'])
		const tuned = await tick({ maxInFlight: 2, maxFixRounds: 3 })
		expect(tuned.slots).toBe(1)
		expect(tuned.fixRounds.map((f) => f.action)).toEqual(['spawn'])
		const invalid = await tick({ maxInFlight: 0, maxFixRounds: 'x' })
		expect(invalid.slots).toBe(5)
		expect(invalid.fixRounds.map((f) => f.action)).toEqual(['block'])
	})

	it('caps live plus new agents at maxAgents, fixes first (#167)', async () => {
		const tick = async (config?: object) => {
			const root = checkout(newTmpDir())
			if (config) fs.outputJsonSync(`${root}/.repo-ai.json`, config)
			await fs.ensureDir(`${root}-worktrees/ai-4-fix`)
			return runLoopTick({
				root,
				env: {},
				now: NOW,
				gh: fakeGh({
					// Live: #1's implementer (no PR), #2's code reviewer, #3's fixer.
					wip: [1, 2, 3, 4],
					prs: [
						pr(20, 'ai-2-review', ['ai-review', 'ai-reviewing-code']),
						pr(21, 'ai-3-fixing', ['ai-changes', 'ai-fixing']),
						pr(22, 'ai-4-fix', ['ai-changes']),
					],
					changes: { 21: 1, 22: 1 },
					queue: [{ number: 40, title: 'ok', body: 'b', labels: [], author_association: 'OWNER' }],
				}),
			})
		}
		const unset = await tick()
		expect(unset.liveAgents).toBe(3)
		expect(unset.fixRounds.map((f) => f.action)).toEqual(['spawn'])
		expect(unset.reviewsToSpawn).toEqual([{ pr: 20, issue: 2, arm: 'sec' }])
		expect(unset.slots).toBe(2)

		const capped = await tick({ maxAgents: 4 })
		expect(capped.fixRounds.map((f) => f.pr)).toEqual([22])
		expect(capped.reviewsToSpawn).toEqual([])
		expect(capped.slots).toBe(0)

		const full = await tick({ maxAgents: 3 })
		expect(full.fixRounds).toEqual([])
		expect(full.slots).toBe(0)
	})

	describe('autoMerge needs the opt-in and the release gate (#142)', () => {
		const tick = async (optIn: boolean, gated: boolean) => {
			const root = checkout(newTmpDir())
			fs.outputFileSync(
				join(root, '.github/workflows/release.yml'),
				'jobs:\n  release:\n    environment: release\n    steps:\n      - run: npx semantic-release\n'
			)
			if (optIn) fs.outputJsonSync(join(root, '.repo-ai.json'), { autoMerge: true })
			git(root, 'add', '-A')
			git(root, 'commit', '-q', '-m', 'setup')
			const r = await runLoopTick({
				root,
				env: {},
				now: NOW,
				gh: fakeGh({
					gated,
					wip: [1],
					prs: [pr(10, 'ai-1-ready', ['ai-review', 'ai-ok-code', 'ai-ok-sec'])],
					merge: { 10: 'CLEAN' },
				}),
			})
			expect(r.releaseGated).toBe(gated)
			return r.handoffs
		}

		it('release-gated without the opt-in: no autoMerge', async () => {
			expect(await tick(false, true)).toEqual([
				{ pr: 10, issue: 1, title: 'pr-10', notes: false, autoMerge: false },
			])
		})

		it('release-gated with the opt-in: autoMerge', async () => {
			expect(await tick(true, true)).toEqual([
				{ pr: 10, issue: 1, title: 'pr-10', notes: false, autoMerge: true },
			])
		})

		it('opt-in but not release-gated: no autoMerge', async () => {
			expect(await tick(true, false)).toEqual([
				{ pr: 10, issue: 1, title: 'pr-10', notes: false, autoMerge: false },
			])
		})
	})

	it('adopts any unlabelled agentUser PR, header or not (#115)', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({
			root,
			env: { AI_LOOP_AGENT: 'agent-bot' },
			now: NOW,
			gh: fakeGh({
				prs: [
					pr(1, 'fix/no-header', [], { author: 'Agent-Bot', body: 'plain' }),
					pr(2, 'fix/header', [], { author: 'agent-bot', body: '🤖 *Opened.*' }),
					pr(3, 'fix/owner', [], { author: 'me-bot', body: '🤖 *Opened.*' }),
					pr(4, 'fix/ready', ['merge-ready'], { author: 'agent-bot' }),
					pr(5, 'dependabot/npm/x', [], { author: 'agent-bot' }),
				],
			}),
		})
		expect(r.env.agentUser).toBe('agent-bot')
		expect(r.adopt).toEqual([1, 2])
	})

	it('picks up bug issues first, keeping queue order within each group (#108)', async () => {
		const root = checkout(newTmpDir())
		const issue = (number: number, labels: string[] = []) => ({
			number,
			title: `#${number}`,
			body: '',
			labels: labels.map((name) => ({ name })),
			author_association: 'OWNER',
		})
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({
				queue: [
					issue(50, ['enhancement']),
					issue(51, ['bug']),
					issue(52),
					issue(53, ['bug', 'docs']),
					issue(54, ['bug', 'holding']),
				],
			}),
		})
		expect(r.pickups.map((p) => p.number)).toEqual([51, 53, 50, 52])
	})

	it('reads the whole ai-ready queue across more than one page (#163)', async () => {
		const root = checkout(newTmpDir())
		const issue = (number: number) => ({
			number,
			title: `#${number}`,
			body: '',
			labels: [],
			author_association: 'OWNER',
		})
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({ queuePages: [[issue(60), issue(61)], [issue(62)]] }),
		})
		expect(r.pickups.map((p) => p.number)).toEqual([60, 61, 62])
	})

	it('drops a candidate naming a file an ai-wip issue already names (#120)', async () => {
		const root = checkout(newTmpDir())
		const issue = (number: number, body: string) => ({
			number,
			title: `#${number}`,
			body,
			labels: [],
			author_association: 'OWNER',
		})
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({
				wip: [{ number: 116, body: 'Edit `src/cli/commands/loop-tick.ts`.' }],
				queue: [issue(115, 'Touches `loop-tick.ts` too.'), issue(117, 'Only `README.md`.')],
			}),
		})
		expect(r.pickups.map((p) => p.number)).toEqual([117])
	})

	it('does not serialise on shared docs every issue touches (#185)', async () => {
		const root = checkout(newTmpDir())
		const issue = (number: number, body: string) => ({
			number,
			title: `#${number}`,
			body,
			labels: [],
			author_association: 'OWNER',
		})
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({
				wip: [
					{
						number: 116,
						body: 'Edit `loop-reap.ts`, `skills/ai-loop/SKILL.md` and `apps/docs/docs/ai-loop.md`.',
					},
				],
				queue: [
					issue(118, 'Update `skills/ai-loop/SKILL.md` and `apps/docs/docs/ai-loop.md`.'),
					issue(119, 'Edit `src/cli/commands/loop-reap.ts` and `README.md`.'),
				],
			}),
		})
		expect(r.pickups.map((p) => p.number)).toEqual([118])
	})

	it('waits on a BLOCKED PR whose required checks are still pending', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({
				wip: [1, 2],
				prs: [
					pr(10, 'ai-1-pending', ['ai-review', 'ai-ok-code', 'ai-ok-sec']),
					pr(11, 'ai-2-ruleset', ['merge-ready']),
				],
				merge: { 10: 'BLOCKED', 11: 'BLOCKED' },
				pending: [10],
			}),
		})
		expect(r.errors).toEqual([])
		expect(r.updateBranches).toEqual([])
		expect(r.sendBacks).toEqual([
			{ pr: 11, issue: 2, reason: 'BLOCKED', label: 'ai-changes', failing: [] },
		])
	})

	it('waits on a BLOCKED PR whose required checks have not reported yet (#112)', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({
				wip: [1, 2],
				prs: [
					pr(10, 'ai-1-unreported', ['ai-review', 'ai-ok-code', 'ai-ok-sec']),
					pr(11, 'ai-2-all-passed', ['ai-review', 'ai-ok-code', 'ai-ok-sec']),
				],
				merge: { 10: 'BLOCKED', 11: 'BLOCKED' },
				unreported: [10],
			}),
		})
		expect(r.errors).toEqual([])
		expect(r.handoffs).toEqual([])
		expect(r.sendBacks).toEqual([
			{ pr: 11, issue: 2, reason: 'BLOCKED', label: 'ai-changes', failing: [] },
		])
	})

	it('sends a DIRTY passed PR back with ai-conflicts, not ai-changes (#176)', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({
				wip: [1],
				prs: [pr(10, 'ai-1-dirty', ['ai-review', 'ai-ok-code', 'ai-ok-sec'])],
				merge: { 10: 'DIRTY' },
			}),
		})
		expect(r.sendBacks).toEqual([
			{ pr: 10, issue: 1, reason: 'DIRTY', label: 'ai-conflicts', failing: [] },
		])
	})

	it("reruns a ci-red PR on its failing run's first attempt, instead of sending it back (#202)", async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({
				wip: [1],
				prs: [pr(10, 'ai-1-flaky', ['ai-review'])],
				failing: [10],
				runIds: { 10: 555 },
				runAttempts: { 555: 1 },
			}),
		})
		expect(r.sendBacks).toEqual([])
		expect(r.rerunFailed).toEqual([{ pr: 10, issue: 1, runId: 555 }])
		expect(r.summary).toContain('1 on CI')
		expect(r.summary).not.toContain('ci-red')
	})

	it('sends a ci-red PR back once its failing run has already been retried (#202)', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({
				wip: [1],
				prs: [pr(10, 'ai-1-still-red', ['ai-review'])],
				failing: [10],
				runIds: { 10: 555 },
				runAttempts: { 555: 2 },
			}),
		})
		expect(r.rerunFailed).toEqual([])
		expect(r.sendBacks).toEqual([
			{
				pr: 10,
				issue: 1,
				reason: 'ci-red',
				label: 'ai-changes',
				failing: [{ name: 'test', link: 'https://github.com/acme/widget/actions/runs/555/job/1' }],
			},
		])
	})

	it('reruns again after a new head starts a fresh run at attempt 1 (#202)', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({
				wip: [1],
				// A new commit is a brand-new run id, not a retried attempt of the old one.
				prs: [pr(10, 'ai-1-new-head', ['ai-review'])],
				failing: [10],
				runIds: { 10: 777 },
				runAttempts: { 555: 2, 777: 1 },
			}),
		})
		expect(r.rerunFailed).toEqual([{ pr: 10, issue: 1, runId: 777 }])
		expect(r.sendBacks).toEqual([])
	})

	it('starts a fixer for ai-conflicts without it costing a fix round (#176)', async () => {
		const root = checkout(newTmpDir())
		await fs.ensureDir(`${root}-worktrees/ai-1-rebase`)
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({
				wip: [1],
				prs: [pr(10, 'ai-1-rebase', ['ai-conflicts'])],
			}),
		})
		expect(r.fixRounds).toEqual([
			{
				pr: 10,
				issue: 1,
				worktree: `${root}-worktrees/ai-1-rebase`,
				applications: 0,
				action: 'spawn',
				reason: 'round 0',
			},
		])
	})

	it('spawns one combined reviewer for a docs-only PR (#53)', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({
				wip: [1, 2, 3],
				prs: [
					pr(20, 'ai-1-docs', ['ai-review']),
					pr(21, 'ai-2-mixed', ['ai-review']),
					pr(22, 'ai-3-unreadable', ['ai-review']),
				],
				diffs: {
					20: ['README.md', 'apps/docs/docs/guide.mdx', '.github/ISSUE_TEMPLATE/bug.yml'],
					21: ['README.md', 'src/index.ts'],
				},
			}),
		})
		expect(r.reviewsToSpawn).toEqual([
			{ pr: 20, issue: 1, arm: 'both' },
			{ pr: 21, issue: 2, arm: 'code' },
			{ pr: 21, issue: 2, arm: 'sec' },
			{ pr: 22, issue: 3, arm: 'code' },
			{ pr: 22, issue: 3, arm: 'sec' },
		])
		expect(r.summary).toBe('3 agents·1 saved')
	})

	it('says agents are idle when every PR waits on the human or CI (#181)', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({
			root,
			env: {},
			now: NOW,
			gh: fakeGh({
				wip: [1, 2, 3],
				prs: [
					pr(30, 'ai-1-handed', ['merge-ready']),
					pr(31, 'ai-2-passed', ['ai-review', 'ai-ok-code', 'ai-ok-sec']),
					pr(32, 'ai-3-behind', ['merge-ready']),
				],
				merge: { 30: 'CLEAN', 31: 'CLEAN', 32: 'BEHIND' },
			}),
		})
		expect(r.summary).toBe('agents idle·1 on CI·2 to merge')
	})
})

describe('isDocsOnly', () => {
	it('takes markdown, docs pages and templates', () => {
		expect(isDocsOnly(['a/b.md', 'x.mdx', '.github/PULL_REQUEST_TEMPLATE.md'])).toBe(true)
		expect(isDocsOnly(['apps/docs/docs/a.ts', '.github/ISSUE_TEMPLATE/config.yml'])).toBe(true)
	})

	it('fails closed on anything that runs or steers an agent', () => {
		for (const f of [
			'skills/ai-loop/SKILL.md',
			'.github/workflows/ci.yml',
			'package.json',
			'pnpm-lock.yaml',
			'src/a.ts',
			'.repo-ai.json',
			'AGENTS.md',
			'CLAUDE.md',
			'packages/x/AGENTS.md',
			'.claude/CLAUDE.md',
			'CLAUDE.local.md',
			'docs/GEMINI.md',
			'.cursorrules',
			'.cursor/rules/x.md',
			'a/.claude/commands/x.md',
			'.github/copilot-instructions.md',
			'.windsurfrules',
			'.windsurf/rules/x.md',
			'packages/x/.Windsurf/rules/x.md',
			'.github/instructions/x.instructions.md',
		])
			expect(isDocsOnly(['README.md', f])).toBe(false)
		// Whole path segments only: ordinary docs stay docs-only.
		for (const f of [
			'apps/docs/docs/intro.md',
			'docs/claude-code.md',
			'docs/windsurf.md',
			'README.md',
			'notes-about-CLAUDE.md',
			'docs/AGENTS.md.bak.md',
		])
			expect(isDocsOnly([f])).toBe(true)
		expect(isDocsOnly([])).toBe(false)
	})
})

describe('staleInstall (#116)', () => {
	/** A HOME whose ~/.claude holds every shipped skill and workflow stamped at `version`. */
	async function home(version?: string): Promise<string> {
		const dir = newTmpDir()
		for (const name of SHIPPED_SKILLS) {
			const s = await readShippedSkill(name)
			await fs.outputFile(
				join(dir, '.claude', 'skills', name, 'SKILL.md'),
				stampSkill(s.content, version ?? s.version)
			)
		}
		for (const name of SHIPPED_WORKFLOWS) {
			const w = await readShippedWorkflow(name)
			await fs.outputFile(
				join(dir, '.claude', 'workflows', `${name}.js`),
				stampWorkflow(w.content, version ?? w.version)
			)
		}
		return dir
	}

	it('names every copy behind the package', async () => {
		const stale = await staleInstall({ HOME: await home('0.0.1') })
		expect(stale).toEqual([
			...SHIPPED_SKILLS.map((n) => `skill ${n}`),
			...SHIPPED_WORKFLOWS.map((n) => `workflow ${n}`),
		])
	})

	it('is empty when the installed copies are current', async () => {
		expect(await staleInstall({ HOME: await home() })).toEqual([])
	})

	it('is empty with no ~/.claude/skills, or no HOME', async () => {
		expect(await staleInstall({ HOME: newTmpDir() })).toEqual([])
		expect(await staleInstall({})).toEqual([])
	})

	it('warns from the tick without leaving idle', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({
			root,
			gh: fakeGh({}),
			env: { HOME: await home('0.0.1') },
			now: NOW,
		})
		expect(r).toMatchObject({ idle: true, exitCode: 0, errors: [] })
		expect(r.staleInstall).toContain('skill ai-loop')
		expect(r.warnings).toEqual([expect.stringContaining('fix claude-skills')])
	})
})

describe('staleInstall — plugin (#154)', () => {
	/** A HOME with a plugin cache for `repo-ai@repo-ai`, one skill's content overridable. */
	async function pluginHome(content: Partial<Record<string, string>> = {}): Promise<string> {
		const dir = newTmpDir()
		const installPath = join(dir, '.claude', 'plugins', 'cache', PLUGIN_NAME, PLUGIN_NAME, 'abc123')
		for (const name of SHIPPED_SKILLS) {
			const s = await readShippedSkill(name)
			await fs.outputFile(join(installPath, 'skills', name, 'SKILL.md'), content[name] ?? s.content)
		}
		await fs.outputJson(join(dir, '.claude', 'plugins', 'installed_plugins.json'), {
			version: 2,
			plugins: { [`${PLUGIN_NAME}@${PLUGIN_NAME}`]: [{ scope: 'user', installPath }] },
		})
		return dir
	}

	it('names a plugin skill copy that differs from the package', async () => {
		const stale = await staleInstall({ HOME: await pluginHome({ 'ai-loop': 'stale content\n' }) })
		expect(stale).toEqual(['plugin skill ai-loop'])
	})

	it('is empty when the plugin copy matches the package', async () => {
		expect(await staleInstall({ HOME: await pluginHome() })).toEqual([])
	})

	it('is empty with no plugin installed, or no HOME', async () => {
		expect(await staleInstall({ HOME: newTmpDir() })).toEqual([])
		expect(await staleInstall({})).toEqual([])
	})

	it('warns with the plugin-update hint, distinct from fix claude-skills', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopTick({
			root,
			gh: fakeGh({}),
			env: { HOME: await pluginHome({ 'ai-loop': 'stale content\n' }) },
			now: NOW,
		})
		expect(r.staleInstall).toEqual(['plugin skill ai-loop'])
		expect(r.warnings).toEqual([expect.stringContaining('/plugin update repo-ai@repo-ai')])
	})
})

describe('problemLines (#128)', () => {
	it('prints errors and warnings on separate, prefixed lines', () => {
		const lines = problemLines({ errors: ['gh api failed'], warnings: ['stale skill'] }).map(
			stripVTControlCharacters
		)
		expect(lines).toEqual(['  error: gh api failed', '  warning: stale skill'])
	})
})
