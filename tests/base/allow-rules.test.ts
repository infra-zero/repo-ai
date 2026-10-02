import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import {
	checkAllowRules,
	checkSandboxExcludes,
	fixSandboxExcludes,
	LOOP_ALLOW_RULES,
	LOOP_SANDBOX_EXCLUDES,
} from '../../src/base/allow-rules.js'
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

describe('checkSandboxExcludes (#257)', () => {
	const sandbox = (file: string, sb: object) => fs.outputJsonSync(file, { sandbox: sb })

	it('is ok and writes nothing with the sandbox off or absent', async () => {
		const dir = newTmpDir()
		const home = newTmpDir()
		expect(await checkSandboxExcludes(dir, home)).toEqual([
			expect.objectContaining({ status: 'ok' }),
		])
		const local = join(dir, '.claude', 'settings.local.json')
		sandbox(join(home, '.claude', 'settings.json'), { enabled: true })
		sandbox(local, { enabled: false })
		expect((await checkSandboxExcludes(dir, home))[0].status).toBe('ok')
		expect(await fixSandboxExcludes(dir, home)).toEqual([])
		expect(fs.readJsonSync(local)).toEqual({ sandbox: { enabled: false } })
	})

	it('drifts per missing exclude; fix adds only those to the enabling file', async () => {
		const dir = newTmpDir()
		const file = join(dir, '.claude', 'settings.local.json')
		fs.outputJsonSync(file, {
			permissions: { allow: ['Bash(gh:*)'] },
			sandbox: { enabled: true, autoAllowBashIfSandboxed: true, excludedCommands: ['docker *'] },
		})
		const results = await checkSandboxExcludes(dir, newTmpDir())
		expect(results.map((r) => r.status)).toEqual(['drift', 'drift'])
		expect(await fixSandboxExcludes(dir, newTmpDir())).toEqual([file])
		expect(fs.readJsonSync(file)).toEqual({
			permissions: { allow: ['Bash(gh:*)'] },
			sandbox: {
				enabled: true,
				autoAllowBashIfSandboxed: true,
				excludedCommands: ['docker *', ...LOOP_SANDBOX_EXCLUDES],
			},
		})
		expect(await checkSandboxExcludes(dir, newTmpDir())).toEqual([
			expect.objectContaining({ status: 'ok' }),
		])
	})

	it('counts excludes from any of the three files, in either prefix spelling', async () => {
		const dir = newTmpDir()
		const home = newTmpDir()
		sandbox(join(dir, '.claude', 'settings.json'), { enabled: true, excludedCommands: ['gh:*'] })
		sandbox(join(home, '.claude', 'settings.json'), {
			excludedCommands: ['npx @rtorcato/repo-ai *'],
		})
		expect((await checkSandboxExcludes(dir, home))[0].status).toBe('ok')
	})
})
