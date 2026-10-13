/**
 * `fix repo-settings` (#362): the GitHub settings the loop needs, and nothing
 * else — squash-only merges, delete-branch-on-merge, auto-merge allowed, and no
 * required PR reviews (the loop's one identity can't approve its own PRs, so a
 * required review deadlocks every PR). Never adds a ruleset or CodeQL, and never
 * removes a required check: it keeps the ones the repo has, and only when there
 * are none does it offer the check names from the default branch's last CI run.
 */
import chalk from 'chalk'
import inquirer from 'inquirer'
import { FixerAbort } from './fixer-abort.js'
import { type GhExec, realGhExec } from './gh.js'

const WANTED = {
	allow_squash_merge: true,
	allow_merge_commit: false,
	allow_rebase_merge: false,
	allow_auto_merge: true,
	delete_branch_on_merge: true,
} as const

type RepoFlags = { -readonly [K in keyof typeof WANTED]?: boolean }

interface Protection {
	required_status_checks?: { contexts?: string[]; checks?: { context: string }[] } | null
	required_pull_request_reviews?: unknown
}

export interface RepoSettingsDeps {
	gh?: GhExec
	/** Which of `names` to require; the default prompts. */
	pickChecks?: (names: string[]) => Promise<string[]>
	/** Apply `plan`? The default prompts, yes by default. */
	confirm?: (plan: string[]) => Promise<boolean>
}

const say = (line: string) => console.error(`   ${line}`)

export async function fixRepoSettings(
	dir: string,
	o: { yes?: boolean; json?: boolean },
	deps: RepoSettingsDeps = {}
): Promise<string[]> {
	const gh: GhExec = deps.gh ?? ((args, stdin) => realGhExec(args, stdin, dir))
	const assumeYes = Boolean(o.yes || o.json)
	// No terminal (e.g. Claude Code's Bash tool) means no prompt: inquirer would die (#358).
	if (!assumeYes && !process.stdin.isTTY && !(deps.confirm && deps.pickChecks)) {
		throw new FixerAbort(
			'no-terminal',
			'no terminal to show the plan and ask before changing repo settings',
			're-run with --yes to apply it'
		)
	}
	const read = async <T>(args: string[]): Promise<T> => {
		const r = await gh(args)
		try {
			if (r.ok) return JSON.parse(r.stdout) as T
		} catch {}
		throw new FixerAbort(
			'repo-settings-unreadable',
			`could not read ${args.find((a) => a.startsWith('repos/')) ?? 'the repo'}: ${r.stderr.trim() || 'gh gave no JSON'}`,
			'Run inside a GitHub checkout, signed in to gh as a repo admin'
		)
	}

	const view = await read<{ nameWithOwner: string; defaultBranchRef: { name: string } }>([
		'repo',
		'view',
		'--json',
		'nameWithOwner,defaultBranchRef',
	])
	const nwo = view.nameWithOwner
	const branch = view.defaultBranchRef.name
	const repo = await read<Record<string, unknown>>(['api', `repos/${nwo}`])
	const patch: RepoFlags = {}
	for (const [k, v] of Object.entries(WANTED) as [keyof typeof WANTED, boolean][])
		if (repo[k] !== v) patch[k] = v

	const protectionRoute = `repos/${nwo}/branches/${encodeURIComponent(branch)}/protection`
	const p = await gh(['api', protectionRoute])
	if (!p.ok && !/HTTP 404/.test(p.stderr)) {
		throw new FixerAbort(
			'repo-settings-unreadable',
			`could not read ${branch}'s branch protection: ${p.stderr.trim() || 'gh failed'}`,
			'Branch protection needs a repo admin: sign in to gh as one'
		)
	}
	const protection: Protection | null = p.ok ? JSON.parse(p.stdout) : null
	const dropReviews = Boolean(protection?.required_pull_request_reviews)
	const existing = [
		...(protection?.required_status_checks?.contexts ?? []),
		...(protection?.required_status_checks?.checks ?? []).map((c) => c.context),
	]

	let addChecks: string[] = []
	if (existing.length > 0) {
		say(`keeping the required checks: ${[...new Set(existing)].join(', ')}`)
	} else {
		const runs = await gh([
			'api',
			`repos/${nwo}/commits/${encodeURIComponent(branch)}/check-runs?per_page=100`,
			'--jq',
			'[.check_runs[].name]',
		])
		const seen = runs.ok ? [...new Set(JSON.parse(runs.stdout || '[]') as string[])].sort() : []
		if (seen.length === 0) {
			say(`no required checks, and no CI run on ${branch} to pick from — add some once CI has run`)
		} else if (assumeYes) {
			// ponytail: no guessing which job is the gate; a human picks, or re-runs without --yes.
			say(
				`no required checks — requiring none. Checks seen on ${branch}: ${seen.join(', ')}. Re-run without --yes to pick`
			)
		} else {
			addChecks = await (deps.pickChecks ?? askChecks)(seen)
		}
	}

	const plan = [
		...Object.entries(patch).map(([k, v]) => `${nwo}: set ${k} to ${v}`),
		...(dropReviews
			? [`${branch}: drop required pull request reviews (the loop can't approve its own PRs)`]
			: []),
		...(addChecks.length > 0 ? [`${branch}: require ${addChecks.join(', ')}`] : []),
	]
	if (plan.length === 0) {
		say('repo settings already match what the loop needs')
		return []
	}
	console.error(chalk.bold('   plan:'))
	for (const line of plan) say(`  ${line}`)
	if (!assumeYes && !(await (deps.confirm ?? askApply)(plan))) {
		say('nothing written')
		return []
	}

	const write = async (args: string[], body?: unknown) => {
		const r = await gh(args, body === undefined ? undefined : JSON.stringify(body))
		if (!r.ok) {
			throw new FixerAbort(
				'repo-settings-write-failed',
				`gh ${args.slice(0, 3).join(' ')} failed: ${r.stderr.trim() || 'gh failed'}`,
				'Repo settings need a repo admin: sign in to gh as one'
			)
		}
	}
	const done: string[] = []
	if (Object.keys(patch).length > 0) {
		await write(['api', '-X', 'PATCH', `repos/${nwo}`, '--input', '-'], patch)
		done.push(`${nwo}: ${Object.keys(patch).join(', ')}`)
	}
	if (dropReviews) {
		await write(['api', '-X', 'DELETE', `${protectionRoute}/required_pull_request_reviews`])
		done.push(`${branch}: no required reviews`)
	}
	if (addChecks.length > 0) {
		if (protection) {
			// Adds to the existing protection; every other rule stays as it is.
			await write(
				['api', '-X', 'PATCH', `${protectionRoute}/required_status_checks`, '--input', '-'],
				{
					strict: false,
					contexts: addChecks,
				}
			)
		} else {
			await write(['api', '-X', 'PUT', protectionRoute, '--input', '-'], {
				required_status_checks: { strict: false, contexts: addChecks },
				enforce_admins: false,
				required_pull_request_reviews: null,
				restrictions: null,
			})
		}
		done.push(`${branch}: requires ${addChecks.join(', ')}`)
	}
	return done
}

async function askChecks(names: string[]): Promise<string[]> {
	const { picked } = await inquirer.prompt([
		{
			type: 'checkbox',
			name: 'picked',
			message:
				'No required checks yet. Which must pass before a PR merges? (pick the job that gates CI)',
			choices: names,
		},
	])
	return picked as string[]
}

async function askApply(): Promise<boolean> {
	const { apply } = await inquirer.prompt([
		{ type: 'confirm', name: 'apply', message: 'Apply these settings?', default: true },
	])
	return Boolean(apply)
}
