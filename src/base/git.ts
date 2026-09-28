import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'

/** `git` runner copied from @rtorcato/repo-tooling (src/base/git-identity.ts), not shared. */

/** Trimmed stdout, or null when git is missing / the key is unset. */
export type GitExec = (args: string[]) => Promise<string | null>

const GIT_TIMEOUT_MS = 5_000

/**
 * Git exports these to everything a hook runs, and they outrank `cwd`/`-C`: a
 * child spawned from a `pre-push` answers about the *hook's* repository, not
 * the directory it was handed. Harmless for a config read; not harmless for
 * `loop guard`, whose whole job is deciding whether one specific checkout has
 * gone bare (#519). Every caller here names its repo explicitly, so the
 * ambient one is never what was meant.
 *
 * This is `git rev-parse --local-env-vars` verbatim — git's own answer, and what
 * githooks(1) says to clear before touching a different repository. Do not
 * curate it by hand: the first version of this list was assembled from the vars
 * that looked repository-ish and missed the `GIT_CONFIG*` family, which
 * redirects where `git config` reads *and writes* — the exact operation this
 * module's callers perform.
 *
 * Kept byte-identical with `AMBIENT_GIT_REPO_VARS` in `scripts/lib/git-env.mjs`;
 * a test asserts both cover what the installed git reports. Two copies because
 * this one compiles into `dist/` for consumers and that one is loaded raw by
 * `.mjs` scripts that run before any build.
 */
export const AMBIENT_REPO_VARS = [
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_CONFIG',
	'GIT_CONFIG_PARAMETERS',
	'GIT_CONFIG_COUNT',
	'GIT_OBJECT_DIRECTORY',
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_IMPLICIT_WORK_TREE',
	'GIT_GRAFT_FILE',
	'GIT_INDEX_FILE',
	'GIT_NO_REPLACE_OBJECTS',
	'GIT_REPLACE_REF_BASE',
	'GIT_PREFIX',
	'GIT_SHALLOW_FILE',
	'GIT_COMMON_DIR',
	// Not in git's local-env list: it scopes which refs are visible rather than
	// which repository is used. Cleared anyway — a namespace inherited from a
	// hook would hide refs from a command that meant to see all of them.
	'GIT_NAMESPACE',
]

function repoScopedEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env }
	for (const key of AMBIENT_REPO_VARS) delete env[key]
	return env
}

/** Never rejects; a missing or failing git resolves to null. */
export const realGitExec = (
	args: string[],
	cwd?: string,
	timeoutMs = GIT_TIMEOUT_MS
): Promise<string | null> =>
	new Promise((resolve) => {
		let settled = false
		const done = (v: string | null) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(v)
		}
		// Args are internal constants, never user free-text — shell:false keeps
		// this injection-safe.
		const child = spawn('git', args, {
			cwd,
			env: repoScopedEnv(),
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		let stdout = ''
		const timer = setTimeout(() => {
			child.kill()
			done(null)
		}, timeoutMs)
		child.stdout?.on('data', (d) => {
			stdout += d
		})
		child.on('close', (code) => done(code === 0 ? stdout.trim() : null))
		child.on('error', () => done(null))
	})

/**
 * The main checkout that `dir` belongs to — via `--git-common-dir`, so it is
 * right from inside a linked worktree too. Falls back to `dir` when it is not a
 * repository, and leaves the verdict to the command. The default for every
 * `loop` command's `--root`, so callers need not pass one (#150).
 */
export function mainCheckout(dir: string = process.cwd()): string {
	try {
		const common = execFileSync(
			'git',
			['rev-parse', '--path-format=absolute', '--git-common-dir'],
			{
				cwd: dir,
				env: repoScopedEnv(),
				stdio: ['ignore', 'pipe', 'ignore'],
				timeout: GIT_TIMEOUT_MS,
			}
		)
			.toString()
			.trim()
		return common ? path.resolve(common, '..') : dir
	} catch {
		return dir
	}
}
