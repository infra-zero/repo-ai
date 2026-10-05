import path from 'node:path'
import chalk from 'chalk'
import fs from 'fs-extra'
import { sameLogin } from '../../base/app-auth.js'
import { type GitExec, realGitExec } from '../../base/git.js'
import { type GhExec, ghPaginated, realGhExec } from '../../base/gh.js'
import {
	ciRunWarning,
	releaseFailedWarning,
	releaseStuckWarning,
	runAttempt,
} from '../../base/ci-runs.js'
import { limit, readConfig } from '../../base/config.js'
import { releaseGated } from '../../base/release-gate.js'
import { securityAlertWarning } from '../../base/security-alerts.js'
import {
	claudeSkillStatus,
	pluginInstallPaths,
	pluginSkillStale,
	SHIPPED_SKILLS,
} from '../generators/claude-skills.js'
import { installWorkflow, SHIPPED_WORKFLOWS, workflowsDirFor } from '../generators/workflows.js'
import { type CleanupEntry, runLoopCleanup } from './loop-cleanup.js'
import { type LoopEnv, resolveLoopEnv } from './loop-env.js'
import { type InstallExec, runLoopGuard } from './loop-guard.js'
import { runLoopVerdict, type Verdict } from './loop-marker.js'
import { labelApplications, type ReapEntry, runLoopReap } from './loop-reap.js'

/**
 * `repo-tooling loop tick` — one ai-loop tick's mechanics as one work
 * list (#620). It composes `loop env`, `loop guard`, `loop cleanup`,
 * `loop reap` and `loop verdict` with the Pass 1 merge-state and CI reads, the
 * Pass 0 PR-adoption query, the Pass 2 `ai-suggested` decay and the Pass 4
 * eligibility query, and says what to do. The skill applies it: every label,
 * assignee, comment, merge and agent spawn stays the agent's call.
 *
 * It writes no GitHub state and removes no worktree (#149): the worktrees whose
 * PR landed or closed come back in `toClean`, and `loop apply` removes them.
 * Its only local writes are `loop guard`'s bare repair and a `git fetch`.
 *
 * Exit non-zero only to halt the tick: `loop guard`'s own code (`1`/`2`), or `1`
 * when the checkout or its GitHub repo cannot be resolved. A failed gh read is
 * not a halt — the lists it feeds are left empty, it lands in `errors`, and the
 * summary leads with `⚠error`.
 */

/** `ai-suggested` issues untouched this long are closed. */
export const DECAY_DAYS = 30
/**
 * `gh issue list`/`gh pr list` have no unbounded mode — `--limit` is the only
 * knob, but gh already pages internally to satisfy it (#163). These reads are
 * each a complete set (every open loop PR, every ai-wip issue, …), so the
 * ceiling is sized to never realistically bind rather than to bound cost.
 */
const LIST_CEILING = '1000'

/** A PR head lagging its branch this long is stuck, not just mid-sync (#219). */
export const RESYNC_MINUTES = 5

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
/** Merge states that name something to fix; any other non-CLEAN state waits. */
const SEND_BACK_STATES = new Set(['DIRTY', 'BLOCKED'])

type Arm = 'code' | 'sec'
const ARMS: Arm[] = ['code', 'sec']

export interface Handoff {
	pr: number
	issue: number | null
	title: string
	notes: boolean
	/** The gated-repo arm: both reviews passed, no `ai-notes`, CLEAN, and `release` gates the publish. */
	autoMerge: boolean
}

export interface SendBack {
	pr: number
	issue: number | null
	/** `ci-red`, or the `mergeStateStatus` that blocks the handoff. */
	reason: 'ci-red' | 'DIRTY' | 'BLOCKED'
	/** `ai-conflicts` for a `DIRTY` merge of the default branch (#176, #216); `ai-changes` for everything else — the label the send-back applies. */
	label: 'ai-changes' | 'ai-conflicts'
	/** Failing required checks, for the comment. */
	failing: { name: string; link: string }[]
	/** Required contexts that never reported on the head, e.g. a job the diff removed or renamed (#268). Absent when none. */
	missing?: string[]
}

export interface RerunFailed {
	pr: number
	issue: number | null
	/** `gh run rerun <runId> --failed` for each — every failing run is on its first attempt; a second failure sends it back (#211). */
	runIds: number[]
}

export interface Resync {
	pr: number
	issue: number | null
	branch: string
	/** The branch head the PR never picked up, and its tree: the empty commit's parent and tree. */
	sha: string
	tree: string
}

/** Pass 1 — a stacked PR whose parent merged: retarget it and merge the default branch in (#253). */
export interface Retarget {
	pr: number
	issue: number | null
	/** The merged parent PR. */
	parent: number
	/** Both reviews passed: a conflict send-back keeps the pass. */
	passed: boolean
	/** The PR body, its `Stacked on #` marker to flip so the retarget runs once. */
	body: string
}

export interface FixRound {
	pr: number
	issue: number | null
	worktree: string | null
	/** `ai-changes` applications so far. */
	applications: number
	/** `block` at the round cap, or when there is no worktree to fix in. */
	action: 'spawn' | 'block'
	reason: string
}

export interface LoopTickResult {
	env: LoopEnv
	/** Why the tick must stop, or null. Nothing below is populated when set. */
	halt: string | null
	idle: boolean
	releaseGated: boolean
	/** Pass 0 — agent-opened PRs with no loop label: add `ai-review`. */
	adopt: number[]
	/** Pass 1 — auto-merge armed before both reviews passed: disarm first. */
	disarm: number[]
	handoffs: Handoff[]
	sendBacks: SendBack[]
	/** Pass 1 — a `ci-red` PR whose failing run's first attempt: rerun instead of a send-back (#202). */
	rerunFailed: RerunFailed[]
	/** Pass 1 — the PR's head lags its branch: push an empty commit so GitHub resyncs it (#219). */
	resync: Resync[]
	retarget: Retarget[]
	/** Pass 1 — passed but `BEHIND`: `gh pr update-branch`; send back only if that fails (#51). */
	updateBranches: { pr: number; issue: number | null }[]
	/** Pass 1 — `merge-ready` that no longer holds (not CLEAN, or `ai-changes`). */
	stripMergeReady: number[]
	/** Pass 1 — flag only, never send back. */
	dependabotCiRed: number[]
	/** Red or DIRTY Dependabot PRs in the loop: asked to `@dependabot recreate`, never sent to a fixer (#240). */
	dependabotRecreate: { pr: number; head: string }[]
	/** A recreate that got no new head within `dependabotStallMinutes`: handed to the human (#255). */
	dependabotStalled: { pr: number; head: string }[]
	/** Pass 2 — worktrees for `loop apply` to remove, and issues to relabel. */
	toClean: CleanupEntry[]
	/** Pass 2 — `loop reap`'s verdicts, to apply. */
	stalled: ReapEntry[]
	/** Pass 2 — `ai-suggested` issues to close. */
	decay: number[]
	/** Pass 3 — a posted verdict to adopt instead of re-spawning. */
	verdicts: { pr: number; arm: Arm; verdict: Verdict }[]
	/** `both` — a docs-only PR: one reviewer with both lenses, posting both markers (#53). */
	reviewsToSpawn: { pr: number; issue: number | null; arm: Arm | 'both' }[]
	fixRounds: FixRound[]
	/** Agents running now, from claim labels (#167). */
	liveAgents: number
	/** Pass 4 — free slots, and every eligible issue in queue order. */
	slots: number
	/** `base`/`stackedOn`: branch from the parent's open PR and target it (#253). */
	pickups: { number: number; title: string; body: string; base?: string; stackedOn?: number }[]
	/** `ai-ready` issues the tick left out of `pickups`, with why (#244). */
	skippedPickups: { number: number; reason: string }[]
	summary: string
	errors: string[]
	/**
	 * Shipped skills/workflows whose installed copy is behind the package's
	 * (#116), plus any plugin-cached skill copy behind it too (#154, `plugin
	 * skill <name>`).
	 */
	staleInstall: string[]
	/** Worth saying, never a reason to leave idle or halt. */
	warnings: string[]
	/** #146/#220: a release run waiting on `release` approval is stale or has waited over an hour. */
	releaseStuck: boolean
	/** #204: the newest completed run's `release` job failed — nothing published. */
	releaseFailed: boolean
	exitCode: 0 | 1 | 2
}

/** Hidden marker on the `@dependabot recreate` comment, so a head is asked once. */
export const recreateMarker = (head: string) => `<!-- ai-loop:recreate:${head} -->`
/** Hidden marker on the stalled-recreate hand-off comment, so a head is escalated once (#255). */
export const stalledMarker = (head: string) => `<!-- ai-loop:stalled:${head} -->`

export interface LoopTickOptions {
	root?: string
	json?: boolean
	/** The dashboard's limits (#305): each set one overrides the repo's `.repo-ai.json`. */
	limits?: Partial<Pick<LoopEnv, 'maxInFlight' | 'maxFixRounds'>>
	/** Test seams. */
	git?: GitExec
	gh?: GhExec
	install?: InstallExec
	env?: NodeJS.ProcessEnv
	now?: Date
}

interface Pr {
	number: number
	title: string
	headRefName: string
	baseRefName: string
	headRefOid?: string
	labels: { name: string }[]
	autoMergeRequest: unknown
	author: { login: string } | null
	body: string | null
	statusCheckRollup?: { conclusion?: string | null; name?: string; context?: string }[] | null
	comments?: { body: string; createdAt?: string }[]
}

interface RestIssue {
	number: number
	title: string
	body: string | null
	pull_request?: unknown
	labels: { name: string }[]
	author_association: string
}

/**
 * Docs-only: nothing in the diff runs, so one reviewer covers both arms (#53).
 * Skills and workflows are `.md`/YAML an agent or runner acts on, so never docs.
 * An empty or unreadable file list fails closed to the full review.
 */
// Files an agent reads as instructions, at any depth, as whole path segments: never docs (#72, #80).
// Case-insensitive because agents load `agents.md` on case-insensitive filesystems; a docs page of that name gets the full review, the safe direction.
const AGENT_INSTRUCTIONS =
	/(^|\/)((AGENTS|CLAUDE(\.local)?|GEMINI|copilot-instructions)\.md|\.cursorrules|\.windsurfrules)$|(^|\/)(\.cursor|\.windsurf|\.claude|\.github\/instructions)\//i

export function isDocsOnly(files: string[]): boolean {
	return (
		files.length > 0 &&
		files.every(
			(f) =>
				!f.startsWith('skills/') &&
				!f.startsWith('.github/workflows/') &&
				!AGENT_INSTRUCTIONS.test(f) &&
				(/\.mdx?$/.test(f) ||
					f.startsWith('apps/docs/docs/') ||
					f.startsWith('.github/ISSUE_TEMPLATE/'))
		)
	)
}

/**
 * `loop tier <pr>` — the review tier from the PR's changed paths, never an agent's judgment (#241).
 * `both`: one combined reviewer. `split`: code + security, also on any failure.
 */
export async function loopTierCommand(
	pr: string,
	options: { dir?: string; json?: boolean }
): Promise<void> {
	const r = await realGhExec(['pr', 'diff', pr, '--name-only'], undefined, options.dir)
	const tier = r.ok && isDocsOnly(r.stdout.split('\n').filter(Boolean)) ? 'both' : 'split'
	if (options.json) console.log(JSON.stringify({ pr: Number(pr), tier }))
	else console.log(tier)
	if (!r.ok) console.error(`gh pr diff failed, defaulting to split: ${r.stderr.trim()}`)
}

/**
 * Basenames of the files an issue body names in backticks, lowercased: `src/a/loop-tick.ts`
 * and `loop-tick.ts` collide. Over-matching only delays a pickup a tick.
 */
// ponytail: backticked spans with an extension only; bare paths slip through to Pass 4's own judgment.
export function namedFiles(body: string): string[] {
	return [...body.matchAll(/`([^`\s]+)`/g)]
		.map((m) => (m[1] ?? '').split('/').pop() ?? '')
		.filter((f) => /^[\w.-]*[\w-]\.[a-z]{1,5}$/i.test(f))
		.map((f) => f.toLowerCase())
		.filter((f) => !SHARED_DOCS.has(f))
}

/**
 * Docs nearly every issue touches in passing. Counting them serialised the whole
 * queue; a markdown conflict comes back as `ai-conflicts`, off the round cap (#185).
 */
const SHARED_DOCS = new Set(['skill.md', 'ai-loop.md', 'readme.md', 'commands.md'])

/** `Depends on #N` in an issue body — same-repo issue numbers only (#253). */
export function dependsOn(body: string): number[] {
	return [...new Set([...body.matchAll(/\bDepends on #(\d+)\b/gi)].map((m) => Number(m[1])))]
}

/** The line a stacked loop PR's body carries, naming its parent PR (#253). */
export const STACKED = /^Stacked on #(\d+)/m

const issueOf = (head: string) => Number(head.match(/^(?:worktree-)?ai-(\d+)-/)?.[1]) || null

/** The workflow run id out of a check's `link` (`…/actions/runs/<id>/job/<id>`), or `null`. */
export function runIdFromLink(link: string): number | null {
	const m = link.match(/\/actions\/runs\/(\d+)/)
	return m ? Number(m[1]) : null
}

export function emptyTick(env: LoopEnv): LoopTickResult {
	return {
		env,
		halt: null,
		idle: false,
		releaseGated: false,
		adopt: [],
		disarm: [],
		handoffs: [],
		sendBacks: [],
		rerunFailed: [],
		resync: [],
		retarget: [],
		updateBranches: [],
		stripMergeReady: [],
		dependabotCiRed: [],
		dependabotRecreate: [],
		dependabotStalled: [],
		toClean: [],
		stalled: [],
		decay: [],
		verdicts: [],
		reviewsToSpawn: [],
		fixRounds: [],
		liveAgents: 0,
		slots: 0,
		pickups: [],
		skippedPickups: [],
		summary: '',
		errors: [],
		staleInstall: [],
		warnings: [],
		releaseStuck: false,
		releaseFailed: false,
		exitCode: 0,
	}
}

export async function runLoopTick(options: LoopTickOptions = {}): Promise<LoopTickResult> {
	const dir = path.resolve(options.root ?? process.cwd())
	const env = await resolveLoopEnv({ dir, git: options.git, gh: options.gh, env: options.env })
	if (options.limits?.maxInFlight !== undefined) env.maxInFlight = options.limits.maxInFlight
	if (options.limits?.maxFixRounds !== undefined) env.maxFixRounds = options.limits.maxFixRounds
	const result = emptyTick(env)
	if (!env.root || !env.ownerRepo) {
		result.halt = env.warnings.join('; ') || 'could not resolve the checkout'
		result.exitCode = 1
		return result
	}
	const { root, ownerRepo } = env
	result.staleInstall = await staleInstall(options.env ?? process.env)
	if (result.staleInstall.length > 0) {
		const fixes = [
			result.staleInstall.some((s) => !s.startsWith('plugin '))
				? 'run `npx @infrazero/repo-ai fix claude-skills`'
				: null,
			result.staleInstall.some((s) => s.startsWith('plugin '))
				? 'run `/plugin update repo-ai@repo-ai` in Claude Code'
				: null,
		].filter((f) => f !== null)
		result.warnings.push(
			`installed copies behind this package: ${result.staleInstall.join(', ')} — ${fixes.join('; ')}`
		)
	}
	const git: GitExec = options.git ?? ((args) => realGitExec(args, root, 120_000))
	const gh: GhExec = options.gh ?? ((args, stdin) => realGhExec(args, stdin, root))
	const now = (options.now ?? new Date()).getTime()
	const errors = result.errors
	const seams = { root, git: options.git, gh: options.gh }

	const config = await readConfig(root)
	const { ciWorkflow } = config
	// #153: worth surfacing even on a halting tick — decoupled from worktree state.
	const ciWarning = await ciRunWarning(gh, ownerRepo, env.defaultBranch, now, ciWorkflow)
	if (ciWarning) result.warnings.push(ciWarning)
	// #146: same reasoning — a stuck approval pins main's push concurrency group.
	const releaseWarning = await releaseStuckWarning(
		gh,
		ownerRepo,
		env.defaultBranch,
		now,
		ciWorkflow,
		root
	)
	if (releaseWarning) {
		result.warnings.push(releaseWarning)
		result.releaseStuck = true
	}
	// #203: high/critical only — moderate/low are doctor's business, not a tick warning.
	const securityWarning = await securityAlertWarning(gh, ownerRepo, false)
	if (securityWarning) result.warnings.push(securityWarning)
	// #204: same reasoning — a failed release job is silent otherwise, and nothing publishes.
	const releaseFailedMsg = await releaseFailedWarning(
		gh,
		ownerRepo,
		env.defaultBranch,
		ciWorkflow,
		root
	)
	if (releaseFailedMsg) {
		result.warnings.push(releaseFailedMsg)
		result.releaseFailed = true
	}

	const guard = await runLoopGuard({ ...seams, install: options.install })
	if (guard.exitCode !== 0) {
		result.halt = guard.messages.filter((m) => m.startsWith('⚠')).join('; ') || 'loop guard failed'
		result.exitCode = guard.exitCode
		return result
	}

	// Best-effort: Pass 4 branches worktrees off the default branch.
	await git(['fetch', '--prune', '--no-write-fetch-head', 'origin'])

	const cleanup = await runLoopCleanup({ ...seams, defaultBranch: env.defaultBranch, dryRun: true })
	result.toClean = cleanup.worktrees.filter((w) => w.action === 'to-remove')
	const live = guard.live

	const reap = await runLoopReap({
		root,
		gh: options.gh,
		now: options.now,
		staleMinutes: env.staleMinutes,
	})
	result.stalled = reap.stalled
	errors.push(...reap.errors)

	const json = async <T>(args: string[]): Promise<T | null> => {
		const r = await gh(args)
		if (r.ok) {
			try {
				return JSON.parse(r.stdout || 'null') as T
			} catch {}
		}
		errors.push(`gh ${args.slice(0, 3).join(' ')} failed: ${r.stderr.trim()}`)
		return null
	}

	// From the diff's file list, never the title, labels or body.
	const docsOnly = async (n: number) => {
		const r = await gh(['pr', 'diff', String(n), '--name-only'])
		return r.ok && isDocsOnly(r.stdout.split('\n').filter(Boolean))
	}

	// A closed issue still wearing ai-wip: its worktree is already gone, so no
	// later cleanup would ever report it. Listing it lets Pass 2 strip the label
	// whatever interrupted the tick that removed the worktree (#23).
	const closedWip = await json<{ number: number }[]>([
		'issue',
		'list',
		'--label',
		'ai-wip',
		'--state',
		'closed',
		'--limit',
		LIST_CEILING,
		'--json',
		'number',
	])
	const cleanedIssues = new Set(result.toClean.map((w) => w.issue))
	for (const { number } of closedWip ?? []) {
		if (cleanedIssues.has(number)) continue
		result.toClean.push({
			path: '',
			issue: number,
			branch: null,
			pr: null,
			prState: null,
			action: 'relabel',
			reason: 'issue closed while still labelled ai-wip',
		})
	}

	const allPrs = await json<Pr[]>([
		'pr',
		'list',
		'--state',
		'open',
		'--limit',
		LIST_CEILING,
		'--json',
		'number,title,headRefName,baseRefName,headRefOid,labels,autoMergeRequest,author,body,statusCheckRollup,comments',
	])
	// Stacked PRs (base isn't the default branch) are out of scope (#233) — except the
	// loop's own, a loop branch on a loop branch (#253).
	const prs = (allPrs ?? []).filter((p) => {
		if (p.baseRefName === env.defaultBranch) return true
		if (issueOf(p.headRefName) && issueOf(p.baseRefName)) return true
		result.warnings.push(
			`#${p.number} targets ${p.baseRefName}, not ${env.defaultBranch} — outside the loop`
		)
		return false
	})
	const wip = await json<{ number: number; body?: string }[]>([
		'issue',
		'list',
		'--label',
		'ai-wip',
		'--state',
		'open',
		'--limit',
		LIST_CEILING,
		'--json',
		'number,body',
	])
	result.releaseGated = await releaseGated(gh, ownerRepo, root)
	// Both keys: the repo's explicit opt-in and a human gate before the registry (#142).
	const autoMerge = config.autoMerge === true && result.releaseGated

	for (const pr of prs ?? []) {
		const labels = new Set(pr.labels.map((l) => l.name))
		const has = (l: string) => labels.has(l)
		const issue = issueOf(pr.headRefName)

		const isDep = pr.headRefName.startsWith('dependabot/')
		// One recreate per head SHA: Dependabot's force-push is a new head, so a still-red PR is not re-asked every tick.
		const recreate = () => {
			const head = pr.headRefOid ?? ''
			const asked = (pr.comments ?? []).find((c) => c.body.includes(recreateMarker(head)))
			if (!asked) return void result.dependabotRecreate.push({ pr: pr.number, head })
			// Asked for this head and still no new one: past the limit, hand it over once (#255).
			const age = now - Date.parse(asked.createdAt ?? '')
			if (
				age >= limit(config, 'dependabotStallMinutes') * 60_000 &&
				!(pr.comments ?? []).some((c) => c.body.includes(stalledMarker(head)))
			)
				result.dependabotStalled.push({ pr: pr.number, head })
		}
		// Dependabot joins the loop once something labels it `ai-review` (#240); until then it is skipped.
		if (isDep && !(has('merge-ready') || [...labels].some((l) => l.startsWith('ai-')))) {
			const red = (pr.statusCheckRollup ?? []).some((c) => c.conclusion === 'FAILURE')
			if (pr.autoMergeRequest && red) result.dependabotCiRed.push(pr.number)
			continue
		}

		const loopPr = has('merge-ready') || [...labels].some((l) => l.startsWith('ai-'))
		if (!loopPr) {
			// With agentUser, `loop guard` pins the tick to that account, so its PRs are the loop's (#115).
			// Without it every agent is the owner's login, and the 🤖 header is the discriminator.
			const author = pr.author?.login
			const adopt = env.agentUser
				? sameLogin(author, env.agentUser)
				: sameLogin(author, env.me) && (pr.body ?? '').startsWith('🤖 ')
			if (adopt) result.adopt.push(pr.number)
			continue
		}

		const passed = (has('ai-ok-code') && has('ai-ok-sec')) || has('merge-ready')
		if (pr.autoMergeRequest && !passed) result.disarm.push(pr.number)
		const claimed = has('ai-reviewing-code') || has('ai-reviewing-sec')

		// A stacked PR whose parent merged: retarget it before anything else reads it (#253).
		const parent = Number((pr.body ?? '').match(STACKED)?.[1]) || null
		if (parent && !(allPrs ?? []).some((p) => p.number === parent)) {
			const r = await gh(['pr', 'view', String(parent), '--json', 'state', '-q', '.state'])
			if (!r.ok) errors.push(`gh pr view ${parent} failed: ${r.stderr.trim()}`)
			const state = r.stdout.trim()
			if (state === 'MERGED') {
				result.retarget.push({ pr: pr.number, issue, parent, passed, body: pr.body ?? '' })
				continue
			}
			if (state === 'CLOSED')
				result.warnings.push(
					`#${pr.number} is stacked on #${parent}, which closed unmerged — needs a human`
				)
		}

		// A push that reached the branch but not the PR: no CI starts and the old head's
		// verdicts look current, so nothing below reads this PR until it catches up (#219).
		if (pr.headRefOid) {
			const branch = await json<{
				commit: { sha: string; commit: { tree: { sha: string }; committer: { date: string } } }
			}>(['api', `repos/${ownerRepo}/branches/${pr.headRefName}`])
			const head = branch?.commit
			if (head && head.sha !== pr.headRefOid) {
				// ponytail: committer date stands in for push time; an old commit pushed late resyncs early, harmlessly.
				const lagging = now - Date.parse(head.commit.committer.date) >= RESYNC_MINUTES * 60_000
				// A fixer mid-push would race the empty commit; its own push resyncs anyway.
				if (lagging && !has('ai-fixing'))
					result.resync.push({
						pr: pr.number,
						issue,
						branch: pr.headRefName,
						sha: head.sha,
						tree: head.commit.tree.sha,
					})
				continue
			}
		}

		// CI red is a send-back, except mid-review or when one is already out.
		let pending = false
		if (!claimed && !has('ai-changes') && !has('ai-conflicts')) {
			const r = await gh([
				'pr',
				'checks',
				String(pr.number),
				'--required',
				'--json',
				'name,state,bucket,link',
			])
			// Exits non-zero whenever a check fails or is pending; stdout is still the answer.
			let checks: { name: string; state: string; bucket?: string; link: string }[] = []
			try {
				checks = JSON.parse(r.stdout || '[]')
			} catch {}
			const failing = checks
				.filter((c) => c.state === 'FAILURE')
				.map(({ name, link }) => ({ name, link }))
			if (failing.length > 0) {
				// One free rerun per head SHA: a fresh commit is a brand-new run at
				// attempt 1, so this needs no state beyond the run's own attempt count.
				// Every failing check's run must be on attempt 1, or the PR never converges
				// to a send-back while one run stays red (#211).
				const ids = failing.map((c) => runIdFromLink(c.link))
				const runIds = [...new Set(ids.filter((id) => id !== null))]
				let first = !ids.includes(null)
				for (const id of runIds) first &&= (await runAttempt(gh, ownerRepo, id)) === 1
				if (first) {
					result.rerunFailed.push({ pr: pr.number, issue, runIds })
				} else if (isDep) {
					recreate()
				} else {
					result.sendBacks.push({
						pr: pr.number,
						issue,
						reason: 'ci-red',
						label: 'ai-changes',
						failing,
					})
				}
				continue
			}
			// No required check reported yet (e.g. `verify` that `needs:` other jobs) is pending too (#112).
			pending = checks.length === 0 || checks.some((c) => c.bucket === 'pending')
		}

		if (has('ai-changes') || has('ai-conflicts')) {
			if (has('merge-ready')) result.stripMergeReady.push(pr.number)
		} else if (passed) {
			// It would merge into the parent's branch, not the default: no handoff until retargeted (#253).
			if (pr.baseRefName !== env.defaultBranch) {
				if (has('merge-ready')) result.stripMergeReady.push(pr.number)
				continue
			}
			const view = await json<{ mergeStateStatus: string }>([
				'pr',
				'view',
				String(pr.number),
				'--json',
				'mergeStateStatus',
			])
			const s = view?.mergeStateStatus ?? 'UNKNOWN'
			if (s === 'CLEAN') {
				const notes = has('ai-notes')
				result.handoffs.push({
					pr: pr.number,
					issue,
					title: pr.title,
					notes,
					autoMerge: autoMerge && !notes,
				})
			} else if (s === 'BEHIND') {
				result.updateBranches.push({ pr: pr.number, issue })
			} else if (s === 'BLOCKED' && pending) {
				// Required checks still running: the next tick sees them land.
			} else if (isDep && SEND_BACK_STATES.has(s)) {
				recreate()
			} else if (SEND_BACK_STATES.has(s)) {
				// A required check that never runs leaves a green PR BLOCKED with no reason given (#268).
				// The bot can read this branch endpoint; `/protection` 404s for it.
				const missing: string[] = []
				const rollup = pr.statusCheckRollup ?? []
				// A pending or failing check is its own reason; only an all-green head names a missing one.
				const allGreen = rollup.every((c) =>
					['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? '')
				)
				if (s === 'BLOCKED' && allGreen) {
					const base = await json<{
						protection?: { required_status_checks?: { contexts?: string[] } }
					}>(['api', `repos/${ownerRepo}/branches/${pr.baseRefName}`])
					const seen = new Set(rollup.map((c) => c.name ?? c.context).filter(Boolean))
					for (const c of base?.protection?.required_status_checks?.contexts ?? [])
						if (!seen.has(c)) missing.push(c)
				}
				result.sendBacks.push({
					pr: pr.number,
					issue,
					reason: s as SendBack['reason'],
					// DIRTY wants the default branch merged in, not a fix — it costs no review round (#176).
					label: s === 'DIRTY' ? 'ai-conflicts' : 'ai-changes',
					failing: [],
					...(missing.length > 0 && { missing }),
				})
			} else if (s !== 'UNKNOWN' && has('merge-ready')) {
				result.stripMergeReady.push(pr.number)
			}
			continue
		}

		if (has('ai-review') && !has('ai-changes')) {
			const spawn: Arm[] = []
			let changes = false
			for (const arm of ARMS) {
				if (has(`ai-ok-${arm}`) || has(`ai-reviewing-${arm}`)) continue
				const v = await runLoopVerdict(pr.number, { dir: root, arm, gh: options.gh })
				if (v.error) errors.push(`verdict ${arm} on #${pr.number}: ${v.error}`)
				else if (v.verdict) {
					result.verdicts.push({ pr: pr.number, arm, verdict: v.verdict })
					changes ||= v.verdict === 'CHANGES'
				} else spawn.push(arm)
			}
			// A CHANGES about to be applied sends the PR back; a review now is wasted.
			if (!changes && spawn.length === ARMS.length && (await docsOnly(pr.number)))
				result.reviewsToSpawn.push({ pr: pr.number, issue, arm: 'both' })
			else if (!changes)
				for (const arm of spawn) result.reviewsToSpawn.push({ pr: pr.number, issue, arm })
		}

		if ((has('ai-changes') || has('ai-conflicts')) && !has('ai-fixing')) {
			// Only `ai-changes` applications spend the round cap — a conflict-only
			// `ai-conflicts` round is free (#176).
			const times = await labelApplications(gh, pr.number, 'ai-changes')
			if (typeof times === 'string') {
				errors.push(times)
				continue
			}
			const slug = pr.headRefName.replace(/^worktree-/, '')
			const worktree = live.find((d) => path.basename(d) === slug) ?? null
			// The round-cap block fires at `maxFixRounds + 1` applications (#158).
			const atCap = times.length > env.maxFixRounds
			result.fixRounds.push({
				pr: pr.number,
				issue,
				worktree,
				applications: times.length,
				action: atCap || !worktree ? 'block' : 'spawn',
				reason: atCap
					? `ai-changes applied ${times.length}× — round cap reached`
					: worktree
						? `round ${times.length}`
						: 'no worktree to fix in',
			})
		}
	}

	const suggested = await json<{ number: number; updatedAt: string; labels: { name: string }[] }[]>(
		[
			'issue',
			'list',
			'--label',
			'ai-suggested',
			'--state',
			'open',
			'--limit',
			LIST_CEILING,
			'--json',
			'number,updatedAt,labels',
		]
	)
	const cutoff = now - DECAY_DAYS * 86_400_000
	result.decay = (suggested ?? [])
		// A promoted suggestion keeps its label; closing a queued one is unrecoverable.
		.filter((i) => !i.labels.some((l) => ['ai-ready', 'ai-wip', 'holding'].includes(l.name)))
		.filter((i) => Date.parse(i.updatedAt) < cutoff)
		.map((i) => i.number)

	// The whole ai-ready queue, not a page of it (#163) — a capped read would
	// silently starve issues past the cap every tick.
	const queue = await ghPaginated<RestIssue>(
		gh,
		`repos/${ownerRepo}/issues?labels=ai-ready&state=open&per_page=100`
	)
	if (queue === null) errors.push(`gh api repos/${ownerRepo}/issues failed`)
	const isBug = (i: RestIssue) => i.labels.some((l) => l.name === 'bug')
	// A candidate sharing a file with an in-flight issue waits its turn (#120).
	const busy = new Set((wip ?? []).flatMap((i) => namedFiles(i.body ?? '')))
	const candidates = (queue ?? [])
		.filter((i) => !i.pull_request)
		.filter((i) => !i.labels.some((l) => ['ai-wip', 'ai-blocked', 'holding'].includes(l.name)))
		// Bugs first; sort is stable, so the API's order holds within each group (#108).
		.sort((a, b) => Number(isBug(b)) - Number(isBug(a)))
	// One level deep: stack on a parent's open PR only when that PR targets the default branch (#253).
	const stackFor = async (
		body: string
	): Promise<string | { base?: string; stackedOn?: number }> => {
		let stack: { base: string; stackedOn: number } | undefined
		for (const n of dependsOn(body)) {
			const parent = (allPrs ?? []).find((p) => issueOf(p.headRefName) === n)
			if (parent) {
				if (parent.baseRefName !== env.defaultBranch)
					return `depends on #${n}, whose PR #${parent.number} is itself stacked — waits for it to merge`
				if (stack) return `depends on more than one open PR — stacks on one parent only`
				stack = { base: parent.headRefName, stackedOn: parent.number }
				continue
			}
			const r = await gh(['issue', 'view', String(n), '--json', 'state', '-q', '.state'])
			if (!r.ok) return `could not read #${n}: ${r.stderr.trim()}`
			if (r.stdout.trim() !== 'CLOSED') return `depends on #${n}, which has no open PR yet`
		}
		return stack ?? {}
	}
	for (const { number, title, body, author_association } of candidates) {
		// The label is the hard gate; association is the backstop.
		if (!TRUSTED.has(author_association)) {
			result.skippedPickups.push({
				number,
				reason: `author association ${author_association} is not OWNER/MEMBER/COLLABORATOR`,
			})
			continue
		}
		const clash = namedFiles(body ?? '').find((f) => busy.has(f))
		if (clash) {
			result.skippedPickups.push({
				number,
				reason: `names ${clash}, which an ai-wip issue also names`,
			})
			continue
		}
		const stack = await stackFor(body ?? '')
		if (typeof stack === 'string') {
			result.skippedPickups.push({ number, reason: stack })
			continue
		}
		result.pickups.push({ number, title, body: body ?? '', ...stack })
	}

	// Slots count what is still in flight once this tick's cleanup and reaping land.
	const freed = new Set([
		...result.toClean.map((w) => w.issue),
		...result.stalled.filter((s) => s.kind === 'implementer').map((s) => s.issue),
	])
	const inFlight = (wip ?? []).filter((i) => !freed.has(i.number)).length
	result.slots = wip ? Math.max(0, env.maxInFlight - inFlight) : 0

	const loopPrs = (prs ?? []).filter((p) =>
		p.labels.some((l) => l.name === 'merge-ready' || l.name.startsWith('ai-'))
	)
	result.liveAgents = liveAgents(loopPrs, wip ?? [], freed, result.stalled)
	if (config.maxAgents !== undefined) capAgents(result, config.maxAgents)
	result.idle =
		errors.length === 0 &&
		loopPrs.length === 0 &&
		live.length === 0 &&
		// `toClean` counts: an idle tick skips Pass 2, which is what strips ai-wip.
		[
			result.adopt,
			result.toClean,
			result.pickups,
			result.stalled,
			result.decay,
			result.dependabotCiRed,
			result.dependabotRecreate,
			result.dependabotStalled,
		].every((l) => l.length === 0)
	result.summary = summarize(result, turns(result, loopPrs, wip ?? [], freed))
	return result
}

/** Claim labels are the shared counter across Workflows (#167); reaped claims are not live. */
export function liveAgents(
	loopPrs: Pr[],
	wip: { number: number }[],
	freed: Set<number | null>,
	stalled: ReapEntry[]
): number {
	const dead = new Set(stalled.filter((s) => s.pr !== null).map((s) => `${s.pr}:${s.label}`))
	const withPr = new Set(loopPrs.map((p) => issueOf(p.headRefName)))
	const claims = loopPrs.flatMap((p) =>
		p.labels
			.map((l) => l.name)
			.filter((l) => ['ai-reviewing-code', 'ai-reviewing-sec', 'ai-fixing'].includes(l))
			.filter((l) => !dead.has(`${p.number}:${l}`))
	)
	return claims.length + wip.filter((i) => !freed.has(i.number) && !withPr.has(i.number)).length
}

/** Trim new spawns so live + new stays within `maxAgents`: fixes, then reviews, then pickups (#167). */
export function capAgents(r: LoopTickResult, maxAgents: number): void {
	let room = Math.max(0, maxAgents - r.liveAgents)
	// A `block` spawns nothing, so it always stays.
	r.fixRounds = r.fixRounds.filter((f) => f.action === 'block' || room-- > 0)
	room = Math.max(0, room)
	r.reviewsToSpawn = r.reviewsToSpawn.slice(0, room)
	room -= r.reviewsToSpawn.length
	r.slots = Math.min(r.slots, room)
}

export interface Turns {
	/** Implementers with no PR yet, plus PRs in review or in a fix round. */
	agents: number
	/** Passed, waiting on checks or a branch update. */
	ci: number
}

/** Whose turn each in-flight item is once this tick's actions land (#181). */
function turns(
	r: LoopTickResult,
	loopPrs: Pr[],
	wip: { number: number }[],
	freed: Set<number | null>
): Turns {
	const human = new Set([
		...r.handoffs.map((h) => h.pr),
		...r.fixRounds.filter((f) => f.action === 'block').map((f) => f.pr),
		...r.dependabotStalled.map((d) => d.pr),
	])
	const sentBack = new Set(r.sendBacks.map((s) => s.pr))
	// A rerun or a resync is waiting on CI, same as a passed PR waiting on checks (#202, #219).
	const rerunning = new Set([
		...r.rerunFailed.map((f) => f.pr),
		...r.resync.map((f) => f.pr),
		...r.retarget.map((f) => f.pr),
	])
	let agents = 0
	let ci = 0
	for (const p of loopPrs) {
		if (human.has(p.number)) continue
		if (rerunning.has(p.number)) {
			ci++
			continue
		}
		const labels = new Set(p.labels.map((l) => l.name))
		const passed =
			(labels.has('ai-ok-code') && labels.has('ai-ok-sec')) || labels.has('merge-ready')
		// An `ai-conflicts` PR keeps its pass labels but waits on a fixer (#217).
		if (passed && !labels.has('ai-conflicts') && !sentBack.has(p.number)) ci++
		else agents++
	}
	const withPr = new Set(loopPrs.map((p) => issueOf(p.headRefName)))
	agents +=
		wip.filter((i) => !freed.has(i.number) && !withPr.has(i.number)).length +
		Math.min(r.slots, r.pickups.length)
	return { agents, ci }
}

/**
 * Ticks follow the installed `~/.claude` copies, not the package's, so name any
 * that `fix claude-skills` would refresh, plus any plugin cache (#132) Claude
 * Code's plugin manager installed behind what this package ships (#154).
 * Read-only; a fork, a missing copy or no install of either kind at all is not
 * stale. `env` is the HOME seam.
 */
export async function staleInstall(env: NodeJS.ProcessEnv): Promise<string[]> {
	const home = env.HOME ?? env.USERPROFILE
	if (!home) return []
	const stale: string[] = []
	const skillsDir = path.join(home, '.claude', 'skills')
	if (await fs.pathExists(skillsDir)) {
		for (const name of SHIPPED_SKILLS) {
			const s = await claudeSkillStatus(name, skillsDir)
			if (s.installed && s.needsInstall) stale.push(`skill ${name}`)
		}
		for (const name of SHIPPED_WORKFLOWS) {
			const w = await installWorkflow(workflowsDirFor(skillsDir), name, { dryRun: true })
			if (w.status === 'updated') stale.push(`workflow ${name}`)
		}
	}
	// The plugin ships skills only (#132) — never a fork, so any mismatch across
	// every install path (scope, marketplace alias) is reported once per name.
	const stalePluginSkills = new Set<string>()
	for (const installPath of await pluginInstallPaths(home)) {
		for (const name of SHIPPED_SKILLS) {
			if (await pluginSkillStale(name, installPath)) stalePluginSkills.add(name)
		}
	}
	for (const name of SHIPPED_SKILLS) {
		if (stalePluginSkills.has(name)) stale.push(`plugin skill ${name}`)
	}
	return stale
}

/** `⚠` segments first, so a truncated phone banner still leads with the stall. */
export function summarize(r: LoopTickResult, t: Turns): string {
	if (r.idle) return 'idle'
	const blocked =
		r.stalled.filter((s) => s.action === 'block').length +
		r.fixRounds.filter((f) => f.action === 'block').length
	const ciRed =
		r.sendBacks.filter((s) => s.reason === 'ci-red').length +
		r.dependabotCiRed.length +
		r.dependabotRecreate.length
	const stalled = r.dependabotStalled.length
	const merge = r.handoffs.length
	const saved = r.reviewsToSpawn.filter((s) => s.arm === 'both').length
	const segments: [number | boolean, string][] = [
		[r.errors.length > 0, '⚠error'],
		[blocked, `⚠${blocked}blocked`],
		[stalled, `⚠${stalled}dependabot-stalled`],
		[ciRed, `⚠${ciRed}ci-red`],
		[r.releaseStuck, '⚠release-stuck'],
		[r.releaseFailed, '⚠release-failed'],
		[t.agents, `${t.agents} agent${t.agents === 1 ? '' : 's'}`],
		[t.ci, `${t.ci} on CI`],
		[merge, `${merge} to merge`],
		// Reviewer agents not spawned: one combined review instead of two.
		[saved, `${saved} saved`],
	]
	const shown = segments.filter(([n]) => n).map(([, s]) => s)
	if (!shown.length) return 'idle'
	// Say so when nothing is running, so waiting on the human never reads as work (#181).
	if (!t.agents) {
		const at = shown.findIndex((s) => !s.startsWith('⚠'))
		shown.splice(at < 0 ? shown.length : at, 0, 'agents idle')
	}
	return shown.join('·')
}

/** Plain-text errors and warnings, each prefixed and coloured so an advisory never reads as a failure. */
export function problemLines(r: Pick<LoopTickResult, 'errors' | 'warnings'>): string[] {
	return [
		...r.errors.map((e) => `  ${chalk.red(`error: ${e}`)}`),
		...r.warnings.map((w) => `  ${chalk.yellow(`warning: ${w}`)}`),
	]
}

export async function loopTickCommand(options: { root?: string; json?: boolean }): Promise<void> {
	const result = await runLoopTick(options)
	if (options.json) {
		console.log(JSON.stringify(result, null, 2))
	} else if (result.halt) {
		console.error(chalk.red(`✖ halt: ${result.halt}`))
	} else {
		console.log(result.summary)
		for (const k of result.skippedPickups) console.log(`  skipped #${k.number}: ${k.reason}`)
		for (const line of problemLines(result)) console.log(line)
	}
	process.exitCode = result.exitCode
}
