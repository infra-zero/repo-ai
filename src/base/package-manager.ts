import path from 'node:path'
import fs from 'fs-extra'

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

/** First match wins, so a repo carrying two lockfiles resolves the same way every time. */
const LOCKFILES: [string, PackageManager][] = [
	['pnpm-lock.yaml', 'pnpm'],
	['bun.lock', 'bun'],
	['bun.lockb', 'bun'],
	['yarn.lock', 'yarn'],
	['package-lock.json', 'npm'],
	['npm-shrinkwrap.json', 'npm'],
]

/**
 * The checkout's package manager, read off its lockfile (#360). Null with no
 * lockfile: the loop then installs nothing and needs no package-manager allow rule.
 */
export async function detectPackageManager(dir: string): Promise<PackageManager | null> {
	if (!dir) return null
	for (const [file, pm] of LOCKFILES) {
		if (await fs.pathExists(path.join(dir, file))) return pm
	}
	return null
}

/**
 * The install command for a worktree, with `<worktree>` left for the skill to
 * write in. Each manager takes the directory as a flag, because the loop's
 * commands start with a plain executable (#150) — never `cd … &&`.
 *
 * None runs dependency lifecycle scripts (#382): a stacked pickup installs an
 * unmerged agent branch's lockfile on the loop host. bun skips them by default;
 * npm and yarn need the flag. pnpm needs it too, since the branch's
 * `allowBuilds`/`onlyBuiltDependencies` re-enable them, plus `--ignore-pnpmfile`,
 * or it runs the branch's `.pnpmfile.cjs` (#395).
 */
export const INSTALL_COMMANDS: Record<PackageManager, string> = {
	pnpm: "pnpm -C '<worktree>' install --ignore-scripts --ignore-pnpmfile",
	npm: "npm --prefix '<worktree>' install --ignore-scripts",
	yarn: "yarn --cwd '<worktree>' install --ignore-scripts",
	bun: "bun install --cwd '<worktree>'",
}

/** Yarn 2+ shares `yarn.lock` but rejects `--ignore-scripts`; `--mode=skip-build` is its equivalent. */
export const YARN_BERRY_INSTALL = "yarn --cwd '<worktree>' install --mode=skip-build"

/** Yarn 2+: a `.yarnrc.yml`, or `packageManager` pinning `yarn@2` or later. */
async function isYarnBerry(dir: string): Promise<boolean> {
	if (await fs.pathExists(path.join(dir, '.yarnrc.yml'))) return true
	const pkg = await fs.readJson(path.join(dir, 'package.json')).catch(() => null)
	return /^yarn@(?:[2-9]|\d{2,})/.test(String(pkg?.packageManager ?? ''))
}

/** The checkout's worktree install command; empty with no lockfile. */
export async function installCommand(dir: string): Promise<string> {
	const pm = await detectPackageManager(dir)
	if (!pm) return ''
	return pm === 'yarn' && (await isYarnBerry(dir)) ? YARN_BERRY_INSTALL : INSTALL_COMMANDS[pm]
}
