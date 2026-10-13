import { join } from 'node:path'
import fs from 'fs-extra'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	checkAllowRules,
	checkSandboxExcludes,
	fixAllowRules,
	fixSandboxExcludes,
	LOOP_ALLOW_RULES,
	LOOP_DENY_RULES,
	LOOP_SANDBOX_EXCLUDES,
	loopAllowRules,
	loopDenyRules,
} from '../../src/base/allow-rules.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

const settings = (file: string, allow: string[], deny: string[] = []) =>
	fs.outputJsonSync(file, { permissions: { allow, deny } })

describe('checkAllowRules (#152)', () => {
	it('warns once per missing rule with no settings files', async () => {
		const results = await checkAllowRules(newTmpDir(), newTmpDir())
		expect(results).toHaveLength(LOOP_ALLOW_RULES.length + LOOP_DENY_RULES.length)
		expect(results.every((r) => r.status === 'drift')).toBe(true)
		for (const rule of [...LOOP_ALLOW_RULES, ...LOOP_DENY_RULES]) {
			expect(results.some((r) => r.detail.includes(rule))).toBe(true)
		}
	})

	it('is ok with every rule, split across user, project and local settings', async () => {
		const dir = newTmpDir()
		const home = newTmpDir()
		settings(join(home, '.claude', 'settings.json'), ['Bash(gh:*)'])
		settings(join(dir, '.claude', 'settings.json'), ['Bash(git *)', 'Bash(pnpm *)'])
		settings(
			join(dir, '.claude', 'settings.local.json'),
			['Bash(npx @infrazero/repo-ai:*)'],
			LOOP_DENY_RULES
		)
		expect(await checkAllowRules(dir, home)).toEqual([expect.objectContaining({ status: 'ok' })])
	})

	it('drifts on a missing deny rule even when every allow rule is there (#373)', async () => {
		const home = newTmpDir()
		settings(join(home, '.claude', 'settings.json'), LOOP_ALLOW_RULES, ['Bash(git -c *)'])
		const results = await checkAllowRules(newTmpDir(), home)
		expect(results.map((r) => r.detail)).toEqual(
			LOOP_DENY_RULES.filter((r) => r !== 'Bash(git -c *)').map((r) =>
				expect.stringContaining(`no "${r}" deny rule`)
			)
		)
	})

	it('warns only for the rules still missing', async () => {
		const dir = newTmpDir()
		fs.outputFileSync(join(dir, 'pnpm-lock.yaml'), '')
		settings(join(dir, '.claude', 'settings.json'), ['Bash(gh:*)', 'Bash(git *)'])
		const results = (await checkAllowRules(dir, newTmpDir())).filter((r) =>
			r.detail.includes('allow rule')
		)
		expect(results.map((r) => r.status)).toEqual(['drift', 'drift'])
		expect(results[0].detail).toContain('Bash(pnpm:*)')
		expect(results[1].detail).toContain('Bash(npx @infrazero/repo-ai *)')
	})

	it("requires the lockfile's package manager, and none without a lockfile (#360)", async () => {
		const dir = newTmpDir()
		expect(await loopAllowRules(dir)).toEqual(LOOP_ALLOW_RULES)
		fs.outputFileSync(join(dir, 'package-lock.json'), '{}')
		expect(await loopAllowRules(dir)).toEqual([
			'Bash(gh:*)',
			'Bash(git *)',
			'Bash(npm:*)',
			'Bash(npx @infrazero/repo-ai *)',
		])
		const details = (await checkAllowRules(dir, newTmpDir())).map((r) => r.detail).join('\n')
		expect(details).toContain('Bash(npm:*)')
		expect(details).not.toContain('pnpm')
	})

	it("denies the lockfile's package manager's runners, and none without a lockfile (#373)", async () => {
		const dir = newTmpDir()
		expect(await loopDenyRules(dir)).toEqual(LOOP_DENY_RULES)
		fs.outputFileSync(join(dir, 'pnpm-lock.yaml'), '')
		expect(await loopDenyRules(dir)).toEqual([
			...LOOP_DENY_RULES,
			'Bash(pnpm dlx *)',
			'Bash(pnpm exec *)',
			'Bash(pnpm create *)',
		])
	})

	it('treats a bare Bash rule as allowing everything', async () => {
		const home = newTmpDir()
		settings(join(home, '.claude', 'settings.json'), ['Bash'])
		expect((await checkAllowRules(newTmpDir(), home))[0].status).toBe('ok')
	})

	it('ignores an unparseable settings file', async () => {
		const dir = newTmpDir()
		fs.outputFileSync(join(dir, '.claude', 'settings.json'), '{ nope')
		expect(await checkAllowRules(dir, newTmpDir())).toHaveLength(
			LOOP_ALLOW_RULES.length + LOOP_DENY_RULES.length
		)
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
			excludedCommands: ['npx @infrazero/repo-ai *'],
		})
		expect((await checkSandboxExcludes(dir, home))[0].status).toBe('ok')
	})
})

describe('fixAllowRules (#371)', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	const local = (dir: string) => join(dir, '.claude', 'settings.local.json')

	it('writes every missing rule into the gitignored settings.local.json, then doctor is ok', async () => {
		const home = newTmpDir()
		const dir = newTmpDir()
		expect(await fixAllowRules(dir, home)).toEqual(['.claude/settings.local.json', '.gitignore'])
		expect(fs.readJsonSync(local(dir)).permissions).toEqual({
			allow: LOOP_ALLOW_RULES,
			deny: LOOP_DENY_RULES,
		})
		expect(fs.readFileSync(join(dir, '.gitignore'), 'utf8')).toContain(
			'.claude/settings.local.json'
		)
		expect(await checkAllowRules(dir, home)).toEqual([expect.objectContaining({ status: 'ok' })])
	})

	it('is idempotent', async () => {
		const home = newTmpDir()
		const dir = newTmpDir()
		await fixAllowRules(dir, home)
		const before = fs.readFileSync(local(dir), 'utf8')
		expect(await fixAllowRules(dir, home)).toEqual([])
		expect(fs.readFileSync(local(dir), 'utf8')).toBe(before)
	})

	it('appends only: keeps other keys, existing rules and their order, and skips equivalents', async () => {
		const home = newTmpDir()
		const dir = newTmpDir()
		fs.outputJsonSync(local(dir), {
			env: { GH_CONFIG_DIR: '/x' },
			permissions: { allow: ['Read', 'Bash(gh *)'], deny: ['Bash(rm:*)'] },
		})
		await fixAllowRules(dir, home)
		expect(fs.readJsonSync(local(dir))).toEqual({
			env: { GH_CONFIG_DIR: '/x' },
			permissions: {
				allow: ['Read', 'Bash(gh *)', ...LOOP_ALLOW_RULES.filter((r) => r !== 'Bash(gh:*)')],
				deny: ['Bash(rm:*)', ...LOOP_DENY_RULES],
			},
		})
	})

	it('writes nothing when another settings file already grants them, or a bare Bash does', async () => {
		const home = newTmpDir()
		settings(join(home, '.claude', 'settings.json'), LOOP_ALLOW_RULES, LOOP_DENY_RULES)
		const dir = newTmpDir()
		expect(await fixAllowRules(dir, home)).toEqual([])
		const bare = newTmpDir()
		settings(join(bare, '.claude', 'settings.json'), ['Bash'])
		expect(await fixAllowRules(bare, newTmpDir())).toEqual([])
		expect(fs.existsSync(local(bare))).toBe(false)
	})

	it('refuses to overwrite an unparseable settings.local.json', async () => {
		const dir = newTmpDir()
		fs.outputFileSync(local(dir), '{ not json')
		await expect(fixAllowRules(dir, newTmpDir())).rejects.toThrow('not valid JSON')
		expect(fs.readFileSync(local(dir), 'utf8')).toBe('{ not json')
	})

	it('refuses to write through a symlinked .claude or settings.local.json (#373)', async () => {
		const elsewhere = newTmpDir()
		const linkedDir = newTmpDir()
		fs.symlinkSync(elsewhere, join(linkedDir, '.claude'))
		await expect(fixAllowRules(linkedDir, newTmpDir())).rejects.toThrow('.claude is a symlink')
		const linkedFile = newTmpDir()
		const target = join(elsewhere, 'target.json')
		fs.outputJsonSync(target, {})
		fs.mkdirSync(join(linkedFile, '.claude'))
		fs.symlinkSync(target, local(linkedFile))
		await expect(fixAllowRules(linkedFile, newTmpDir())).rejects.toThrow(
			'.claude/settings.local.json is a symlink'
		)
		expect(fs.readdirSync(elsewhere)).toEqual(['target.json'])
		expect(fs.readJsonSync(target)).toEqual({})
	})
})
