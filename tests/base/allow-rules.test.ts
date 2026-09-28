import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import { checkAllowRules, LOOP_ALLOW_RULES } from '../../src/base/allow-rules.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

const settings = (file: string, allow: string[]) =>
	fs.outputJsonSync(file, { permissions: { allow } })

describe('checkAllowRules (#152)', () => {
	it('warns once per missing rule with no settings files', async () => {
		const results = await checkAllowRules(newTmpDir(), newTmpDir())
		expect(results).toHaveLength(LOOP_ALLOW_RULES.length)
		expect(results.every((r) => r.status === 'drift')).toBe(true)
		for (const rule of LOOP_ALLOW_RULES) {
			expect(results.some((r) => r.detail.includes(rule))).toBe(true)
		}
	})

	it('is ok with every rule, split across user, project and local settings', async () => {
		const dir = newTmpDir()
		const home = newTmpDir()
		settings(join(home, '.claude', 'settings.json'), ['Bash(gh:*)'])
		settings(join(dir, '.claude', 'settings.json'), ['Bash(git *)', 'Bash(pnpm *)'])
		settings(join(dir, '.claude', 'settings.local.json'), ['Bash(npx @rtorcato/repo-ai:*)'])
		expect(await checkAllowRules(dir, home)).toEqual([expect.objectContaining({ status: 'ok' })])
	})

	it('warns only for the rules still missing', async () => {
		const dir = newTmpDir()
		settings(join(dir, '.claude', 'settings.json'), ['Bash(gh:*)', 'Bash(git *)'])
		const results = await checkAllowRules(dir, newTmpDir())
		expect(results.map((r) => r.status)).toEqual(['drift', 'drift'])
		expect(results[0].detail).toContain('Bash(pnpm:*)')
		expect(results[1].detail).toContain('Bash(npx @rtorcato/repo-ai *)')
	})

	it('treats a bare Bash rule as allowing everything', async () => {
		const home = newTmpDir()
		settings(join(home, '.claude', 'settings.json'), ['Bash'])
		expect((await checkAllowRules(newTmpDir(), home))[0].status).toBe('ok')
	})

	it('ignores an unparseable settings file', async () => {
		const dir = newTmpDir()
		fs.outputFileSync(join(dir, '.claude', 'settings.json'), '{ nope')
		expect(await checkAllowRules(dir, newTmpDir())).toHaveLength(LOOP_ALLOW_RULES.length)
	})
})
