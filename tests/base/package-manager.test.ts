import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import { detectPackageManager, installCommand } from '../../src/base/package-manager.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

describe('detectPackageManager (#360)', () => {
	it.each([
		['pnpm-lock.yaml', 'pnpm'],
		['bun.lock', 'bun'],
		['bun.lockb', 'bun'],
		['yarn.lock', 'yarn'],
		['package-lock.json', 'npm'],
		['npm-shrinkwrap.json', 'npm'],
	])('reads %s as %s', async (file, pm) => {
		const dir = newTmpDir()
		fs.outputFileSync(join(dir, file), '')
		expect(await detectPackageManager(dir)).toBe(pm)
	})

	it('is null with no lockfile or no directory', async () => {
		expect(await detectPackageManager(newTmpDir())).toBeNull()
		expect(await detectPackageManager('')).toBeNull()
	})

	it('prefers pnpm when a stray package-lock.json sits beside its lockfile', async () => {
		const dir = newTmpDir()
		fs.outputFileSync(join(dir, 'package-lock.json'), '{}')
		fs.outputFileSync(join(dir, 'pnpm-lock.yaml'), '')
		expect(await detectPackageManager(dir)).toBe('pnpm')
	})
})

// #382: a stacked pickup installs an unmerged branch's lockfile, so no manager runs lifecycle scripts.
describe('installCommand', () => {
	it.each([
		[{ 'pnpm-lock.yaml': '' }, "pnpm -C '<worktree>' install"],
		[{ 'bun.lock': '' }, "bun install --cwd '<worktree>'"],
		[{ 'package-lock.json': '{}' }, "npm --prefix '<worktree>' install --ignore-scripts"],
		[{ 'yarn.lock': '' }, "yarn --cwd '<worktree>' install --ignore-scripts"],
		[
			{ 'yarn.lock': '', 'package.json': '{"packageManager":"yarn@1.22.22"}' },
			"yarn --cwd '<worktree>' install --ignore-scripts",
		],
		[{ 'yarn.lock': '', '.yarnrc.yml': '' }, "yarn --cwd '<worktree>' install --mode=skip-build"],
		[
			{ 'yarn.lock': '', 'package.json': '{"packageManager":"yarn@4.5.0"}' },
			"yarn --cwd '<worktree>' install --mode=skip-build",
		],
		[{}, ''],
	])('%o → %s', async (files, command) => {
		const dir = newTmpDir()
		for (const [file, body] of Object.entries(files)) fs.outputFileSync(join(dir, file), body)
		expect(await installCommand(dir)).toBe(command)
	})
})
