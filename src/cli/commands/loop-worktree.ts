import { spawnSync } from 'node:child_process'
import path from 'node:path'
import chalk from 'chalk'
import fs from 'fs-extra'
import { resolveDefaultBranch } from '../../base/default-branch.js'
import { type GhExec, realGhExec } from '../../base/gh.js'
import { type GitExec, realGitExec } from '../../base/git.js'
import { isYarnBerry, YARN_BERRY_ARGS } from '../../base/package-manager.js'
import { defaultWorktreeRoot } from './loop-guard.js'

/**
 * `repo-tooling loop worktree add` — the ai-loop skill's Pass 4
 * worktree creation, moved into code (#616): `git worktree add`, linking every
 * `worktree.symlinkDirectories` entry, the `.git/info/exclude` line, and the
 * assertion that nothing was left unlinked.
 *
 * The prose version iterated `for d in $DIRS`, which zsh does not word-split,
 * so it silently linked nothing (#585). An array has no such failure mode.
 *
 * Exit `0` means the worktree is ready for an implementer. Exit `1` means do
 * not spawn one — either the worktree was not created, or an entry that exists
 * in the main checkout has no link in the worktree. `needsInstall` (exit `0`)
 * means the repo declares no symlink list, so nothing was linked and a real
 * install in the worktree is safe.
 */

/** `ai-<issue>-<kebab words>` — it becomes a branch name and a path segment. */
export const SLUG = /^ai-\d+-[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface LoopWorktreeAddResult {
	root: string
	worktree: string
	branch: string
	/** Entries now symlinked into the worktree. */
	linked: string[]
	/** Entries present in the main checkout but not linked — fatal. */
	missing: string[]
	/** No `worktree.symlinkDirectories` — run a real install in the worktree. */
	needsInstall: boolean
	exitCode: 0 | 1
	messages: string[]
}

export interface LoopWorktreeAddOptions {
	root?: string
	worktreeRoot?: string
	base?: string
	json?: boolean
	/** Test seams. */
	git?: GitExec
	gh?: GhExec
}

/**
 * Relative and inside the checkout, or dropped: the list comes from a
 * committed file, and `../x` would otherwise link outside both trees.
 */
function safeEntry(entry: unknown): entry is string {
	if (typeof entry !== 'string' || entry.trim() === '') return false
	const n = path.normalize(entry)
	return !path.isAbsolute(n) && n !== '..' && !n.startsWith(`..${path.sep}`)
}

export async function symlinkDirectories(root: string): Promise<string[]> {
	const settings = await fs.readJson(path.join(root, '.claude', 'settings.json')).catch(() => null)
	const dirs = settings?.worktree?.symlinkDirectories
	return Array.isArray(dirs) ? dirs.filter(safeEntry) : []
}

/**
 * `node_modules/` with a trailing slash does not match a symlink, so a
 * `git add -A` would commit every link. No slash matches at any depth. The
 * exclude file is shared by every worktree and never committed.
 */
async function ensureExcluded(root: string): Promise<boolean> {
	const file = path.join(root, '.git', 'info', 'exclude')
	const current = await fs.readFile(file, 'utf8').catch(() => '')
	if (current.split('\n').includes('node_modules')) return false
	await fs.outputFile(
		file,
		`${current}${current && !current.endsWith('\n') ? '\n' : ''}node_modules\n`
	)
	return true
}

async function isSymlink(p: string): Promise<boolean> {
	return fs
		.lstat(p)
		.then((s) => s.isSymbolicLink())
		.catch(() => false)
}

export async function runLoopWorktreeAdd(
	slug: string,
	options: LoopWorktreeAddOptions = {}
): Promise<LoopWorktreeAddResult> {
	const root = path.resolve(options.root ?? process.cwd())
	const worktreeRoot = options.worktreeRoot
		? path.resolve(options.worktreeRoot)
		: defaultWorktreeRoot(root)
	const worktree = path.join(worktreeRoot, slug)
	// A checkout of a real repo takes longer than realGitExec's 5s default.
	const git: GitExec = options.git ?? ((args) => realGitExec(args, root, 120_000))
	const gh: GhExec = options.gh ?? ((args, stdin) => realGhExec(args, stdin, root))
	const result: LoopWorktreeAddResult = {
		root,
		worktree,
		branch: slug,
		linked: [],
		missing: [],
		needsInstall: false,
		exitCode: 1,
		messages: [],
	}

	if (!SLUG.test(slug)) {
		result.messages.push(`⚠ '${slug}' is not ai-<issue>-<kebab-slug>`)
		return result
	}
	let base = options.base
	if (base === undefined) {
		const defaultBranch = await resolveDefaultBranch(git, gh)
		if (!defaultBranch) {
			result.messages.push('⚠ could not resolve the default branch — pass --base')
			return result
		}
		base = `origin/${defaultBranch}`
	}
	// Goes to git as an argument; a leading dash would be read as an option.
	if (base.startsWith('-')) {
		result.messages.push(`⚠ '${base}' is not a ref`)
		return result
	}

	await fs.ensureDir(worktreeRoot)
	if ((await git(['worktree', 'add', worktree, '-b', slug, base])) === null) {
		result.messages.push(
			`⚠ git worktree add failed — does branch ${slug} or ${worktree} already exist?`
		)
		return result
	}
	result.messages.push(`created ${worktree} on ${slug}`)

	// Before linking, so the links are never momentarily untracked-and-addable.
	if (await ensureExcluded(root)) result.messages.push('added node_modules to .git/info/exclude')

	const dirs = await symlinkDirectories(root)
	if (dirs.length === 0) {
		result.needsInstall = true
		result.messages.push(
			// #363: `fix ai` is repo-tooling's, not ours — name it in full.
			'no worktree.symlinkDirectories — run a real install in the worktree (optional: `npx @rtorcato/repo-tooling fix ai` writes the list and restores the fast path)'
		)
	}
	for (const d of dirs) {
		const source = path.join(root, d)
		// An entry pointing at nothing links nothing, and is not missing.
		if (!(await fs.pathExists(source))) continue
		const target = path.join(worktree, d)
		await fs.ensureDir(path.dirname(target))
		await fs.symlink(source, target).catch(() => {})
		if (await isSymlink(target)) result.linked.push(d)
		else result.missing.push(d)
	}

	if (result.missing.length > 0) {
		result.messages.push(
			`⚠ FATAL: no symlink for ${result.missing.join(', ')} — do not spawn an implementer`
		)
		return result
	}
	if (result.linked.length > 0) result.messages.push(`linked ${result.linked.join(', ')}`)
	result.exitCode = 0
	return result
}

export async function loopWorktreeAddCommand(
	slug: string,
	options: { root?: string; worktreeRoot?: string; base?: string; json?: boolean }
): Promise<void> {
	const result = await runLoopWorktreeAdd(slug, options)
	if (options.json) {
		console.log(JSON.stringify(result, null, 2))
	} else {
		for (const line of result.messages) {
			console.log(`  ${line.startsWith('⚠') ? chalk.yellow(line) : chalk.gray(line)}`)
		}
	}
	process.exitCode = result.exitCode
}

export interface LoopWorktreeInstallOptions {
	root?: string
	worktreeRoot?: string
	/** Test seam: runs `yarn <args>` in `cwd`, returns its exit code. */
	run?: (args: string[], cwd: string) => number
}

const realRun = (args: string[], cwd: string): number =>
	spawnSync('yarn', args, { cwd, stdio: 'inherit' }).status ?? 1

/**
 * `loop worktree install <worktree>` — the Yarn 2+ worktree install (#394), run
 * with the worktree as its working directory because Yarn 3 and 4 accept `--cwd`
 * in opposite positions. Only inside the worktree root, so it never installs in
 * the main checkout.
 */
export async function runLoopWorktreeInstall(
	worktree: string,
	options: LoopWorktreeInstallOptions = {}
): Promise<{ exitCode: number; message?: string }> {
	const root = path.resolve(options.root ?? process.cwd())
	const worktreeRoot = options.worktreeRoot
		? path.resolve(options.worktreeRoot)
		: defaultWorktreeRoot(root)
	const real = await fs.realpath(worktree).catch(() => '')
	const rel = real && path.relative(await fs.realpath(worktreeRoot).catch(() => worktreeRoot), real)
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
		return { exitCode: 1, message: `⚠ ${worktree} is not a worktree under ${worktreeRoot}` }
	}
	if (!(await isYarnBerry(real))) {
		return { exitCode: 1, message: `⚠ ${worktree} is not a Yarn 2+ checkout` }
	}
	return { exitCode: (options.run ?? realRun)(YARN_BERRY_ARGS, real) }
}

export async function loopWorktreeInstallCommand(
	worktree: string,
	options: { root?: string; worktreeRoot?: string }
): Promise<void> {
	const result = await runLoopWorktreeInstall(worktree, options)
	if (result.message) console.error(`  ${chalk.yellow(result.message)}`)
	process.exitCode = result.exitCode
}
