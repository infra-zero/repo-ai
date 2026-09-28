import type { GhExec } from './gh.js'
import type { GitExec } from './git.js'

/**
 * The repo's default branch, resolved once and reused everywhere a hard-coded
 * `origin/main` used to be (#161): `git symbolic-ref refs/remotes/origin/HEAD`,
 * falling back to `gh repo view` when origin/HEAD was never recorded locally
 * (a fresh clone that skipped `git remote set-head`, or a linked worktree).
 * Never `origin/`-prefixed — a caller that wants a ref joins it itself. Empty
 * when neither resolves.
 */
export async function resolveDefaultBranch(git: GitExec, gh: GhExec): Promise<string> {
	const symbolic = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'])
	const fromGit = symbolic?.trim().replace(/^refs\/remotes\/origin\//, '')
	if (fromGit) return fromGit
	const r = await gh([
		'repo',
		'view',
		'--json',
		'defaultBranchRef',
		'--jq',
		'.defaultBranchRef.name',
	])
	return r.ok ? r.stdout.trim() : ''
}
