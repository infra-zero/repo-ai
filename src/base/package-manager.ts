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
 */
export const INSTALL_COMMANDS: Record<PackageManager, string> = {
	pnpm: "pnpm -C '<worktree>' install",
	npm: "npm --prefix '<worktree>' install",
	yarn: "yarn --cwd '<worktree>' install",
	bun: "bun install --cwd '<worktree>'",
}
