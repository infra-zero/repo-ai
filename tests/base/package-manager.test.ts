import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import { detectPackageManager } from '../../src/base/package-manager.js'
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
