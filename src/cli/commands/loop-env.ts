import path from 'node:path'
import { LOGIN } from '../../base/agent-user.js'
import { DEFAULT_BUDGET_TOKENS, DEFAULT_QUIET_STOP_MINUTES, readConfig } from '../../base/config.js'
import { resolveDefaultBranch } from '../../base/default-branch.js'
import { type GitExec, realGitExec } from '../../base/git.js'
import { type GhExec, realGhExec } from '../../base/gh.js'
import { configuredAgentUser, defaultWorktreeRoot } from './loop-guard.js'

/**
 * `repo-tooling loop env` — the ai-loop skill's Pass 0 variables,
 * resolved once (#615). The skill used to derive each in its own bash snippet
 * and re-ran `gh api user` in four places; the semantics below are those
 * snippets', unchanged.
 *
 * Every field is a string and empty means "none" — the skill's
 * `${VAR:+--flag}` expansions depend on exactly that.
 */
export interface LoopEnv {
	/** Main checkout — via `--git-common-dir`, so correct from inside a worktree. */
	root: string
	/** Sibling `<root>-worktrees`. */
	worktreeRoot: string
	/** From the working directory's remote, never from an argument. */
	ownerRepo: string
	/** The repo's default branch (`main`, `master`, …), never `origin/`-prefixed. Empty when unresolvable. */
	defaultBranch: string
	/** `AI_LOOP_AGENT`, else `rules.aiLoop.agentUser`; empty unless assignable. */
	agentUser: string
	/** `humanUser`, else the repo owner when it is a User; empty for an organisation with no `humanUser` set (#162). */
	humanUser: string
	/** Who `gh` authenticates as. */
	me: string
	/** `budgetTokens`, else {@link DEFAULT_BUDGET_TOKENS} — the Workflow scripts' per-tick cap (#41). */
	budgetTokens: number
	/** `quietStopMinutes`, else {@link DEFAULT_QUIET_STOP_MINUTES}; `0` disables Pass 5's cutoff (#124). */
	quietStopMinutes: number
	warnings: string[]
}

export interface LoopEnvOptions {
	dir?: string
	json?: boolean
	/** Test seams. */
	git?: GitExec
	gh?: GhExec
	env?: NodeJS.ProcessEnv
}

export async function ghOut(gh: GhExec, args: string[]): Promise<string> {
	const r = await gh(args)
	return r.ok ? r.stdout.trim() : ''
}

export async function resolveLoopEnv(options: LoopEnvOptions = {}): Promise<LoopEnv> {
	const dir = path.resolve(options.dir ?? process.cwd())
	const git: GitExec = options.git ?? ((args) => realGitExec(args, dir))
	const gh: GhExec = options.gh ?? ((args, stdin) => realGhExec(args, stdin, dir))
	const env = options.env ?? process.env
	const warnings: string[] = []

	// Absolute, so the common dir is `<main checkout>/.git` from anywhere.
	const common = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim()
	const root = common ? path.resolve(common, '..') : ''
	if (!root) warnings.push('not a git repository')
	const worktreeRoot = root ? defaultWorktreeRoot(root) : ''

	const ownerRepo = await ghOut(gh, [
		'repo',
		'view',
		'--json',
		'nameWithOwner',
		'--jq',
		'.nameWithOwner',
	])
	if (!ownerRepo) warnings.push('could not resolve the GitHub repo from the working directory')

	const defaultBranch = await resolveDefaultBranch(git, gh)
	if (!defaultBranch) warnings.push('could not resolve the default branch')

	let agentUser = env.AI_LOOP_AGENT?.trim() || (root ? await configuredAgentUser(root) : '') || ''
	// LOGIN is the injection boundary — the login goes into an API path.
	if (
		agentUser &&
		(!ownerRepo ||
			!LOGIN.test(agentUser) ||
			!(await gh(['api', `repos/${ownerRepo}/assignees/${agentUser}`, '--silent'])).ok)
	) {
		warnings.push(`agentUser '${agentUser}' is not an assignable collaborator — assigning nothing`)
		agentUser = ''
	}

	const config = root ? await readConfig(root) : null
	const humanUser =
		config?.humanUser ||
		(ownerRepo
			? await ghOut(gh, [
					'api',
					`repos/${ownerRepo}`,
					'--jq',
					'if .owner.type == "User" then .owner.login else "" end',
				])
			: '')
	const me = await ghOut(gh, ['api', 'user', '--jq', '.login'])
	const budgetTokens = config?.budgetTokens ?? DEFAULT_BUDGET_TOKENS
	const quietStopMinutes = config?.quietStopMinutes ?? DEFAULT_QUIET_STOP_MINUTES

	return {
		root,
		worktreeRoot,
		ownerRepo,
		defaultBranch,
		agentUser,
		humanUser,
		me,
		budgetTokens,
		quietStopMinutes,
		warnings,
	}
}

const VARS: [string, keyof Omit<LoopEnv, 'warnings'>][] = [
	['ROOT', 'root'],
	['WT_ROOT', 'worktreeRoot'],
	['OWNER_REPO', 'ownerRepo'],
	['DEFAULT_BRANCH', 'defaultBranch'],
	['AGENT_USER', 'agentUser'],
	['HUMAN_USER', 'humanUser'],
	['ME', 'me'],
	['BUDGET_TOKENS', 'budgetTokens'],
	['QUIET_STOP_MINUTES', 'quietStopMinutes'],
]

/** `KEY='value'` lines, single-quoted so `eval "$(… loop env)"` is safe. */
export function toShell(env: LoopEnv): string {
	return VARS.map(([name, key]) => `${name}='${String(env[key]).replaceAll("'", `'\\''`)}'`).join(
		'\n'
	)
}

export async function loopEnvCommand(options: { dir?: string; json?: boolean }): Promise<void> {
	const env = await resolveLoopEnv(options)
	if (options.json) {
		console.log(JSON.stringify(env, null, 2))
	} else {
		for (const w of env.warnings) console.error(`⚠ ${w}`)
		console.log(toShell(env))
	}
	// Nothing downstream works without both — the skill bails on either.
	process.exitCode = env.root && env.ownerRepo ? 0 : 1
}
