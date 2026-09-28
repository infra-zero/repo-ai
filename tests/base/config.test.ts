import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import { LIMITS, limit, readConfig } from '../../src/base/config.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

describe('readConfig', () => {
	it('reads .repo-ai.json when present', async () => {
		const dir = newTmpDir()
		fs.outputJsonSync(join(dir, '.repo-ai.json'), {
			agentUser: 'some-bot',
			requiredSkills: ['ai-loop'],
		})
		expect(await readConfig(dir)).toEqual({
			agentUser: 'some-bot',
			requiredSkills: ['ai-loop'],
			autoMerge: false,
			source: 'repo-ai.json',
		})
	})

	it('reads pollSeconds, floored at 60', async () => {
		const dir = newTmpDir()
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { pollSeconds: 300 })
		expect((await readConfig(dir)).pollSeconds).toBe(300)
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { pollSeconds: 10 })
		expect((await readConfig(dir)).pollSeconds).toBe(60)
	})

	it('reads budgetTokens, ignoring a value below the 1000 floor', async () => {
		const dir = newTmpDir()
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { budgetTokens: 50_000 })
		expect((await readConfig(dir)).budgetTokens).toBe(50_000)
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { budgetTokens: 10 })
		expect((await readConfig(dir)).budgetTokens).toBeUndefined()
	})

	it.each(Object.entries(LIMITS) as [keyof typeof LIMITS, { default: number; min: number }][])(
		'%s: default, override, and invalid fallback (#158)',
		async (key, { default: def, min }) => {
			const dir = newTmpDir()
			fs.outputJsonSync(join(dir, '.repo-ai.json'), {})
			expect(limit(await readConfig(dir), key)).toBe(def)
			expect(limit(null, key)).toBe(def)
			fs.outputJsonSync(join(dir, '.repo-ai.json'), { [key]: min + 7 })
			expect(limit(await readConfig(dir), key)).toBe(min + 7)
			for (const bad of [min - 1, 'x', null, Number.NaN]) {
				fs.outputJsonSync(join(dir, '.repo-ai.json'), { [key]: bad })
				expect(limit(await readConfig(dir), key)).toBe(def)
			}
		}
	)

	it('reads quietStopMinutes, keeping 0 and ignoring a negative value', async () => {
		const dir = newTmpDir()
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { quietStopMinutes: 0 })
		expect((await readConfig(dir)).quietStopMinutes).toBe(0)
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { quietStopMinutes: -5 })
		expect((await readConfig(dir)).quietStopMinutes).toBeUndefined()
	})

	it('reads autoMerge only when literally true (#142)', async () => {
		const dir = newTmpDir()
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { autoMerge: true })
		expect((await readConfig(dir)).autoMerge).toBe(true)
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { autoMerge: 'yes' })
		expect((await readConfig(dir)).autoMerge).toBe(false)
	})

	it('reads ciWorkflow, trimmed, and ignores a blank one (#201)', async () => {
		const dir = newTmpDir()
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { ciWorkflow: ' test.yml ' })
		expect((await readConfig(dir)).ciWorkflow).toBe('test.yml')
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { ciWorkflow: '  ' })
		expect((await readConfig(dir)).ciWorkflow).toBeUndefined()
	})

	it('reads humanUser, trimmed, and ignores a blank one (#162)', async () => {
		const dir = newTmpDir()
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { humanUser: ' acme-owner ' })
		expect((await readConfig(dir)).humanUser).toBe('acme-owner')
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { humanUser: '  ' })
		expect((await readConfig(dir)).humanUser).toBeUndefined()
	})

	it('ignores .repo-tooling.json — no fallback (#159)', async () => {
		const dir = newTmpDir()
		fs.outputJsonSync(join(dir, '.repo-tooling.json'), {
			rules: { aiLoop: { agentUser: 'legacy-bot' }, requiredSkills: ['ai-workflow'] },
		})
		expect(await readConfig(dir)).toEqual({ source: 'none' })
	})

	it('ignores a blank agentUser and a non-string skill list', async () => {
		const dir = newTmpDir()
		fs.outputJsonSync(join(dir, '.repo-ai.json'), {
			agentUser: '  ',
			requiredSkills: 'not-an-array',
		})
		expect(await readConfig(dir)).toEqual({
			agentUser: undefined,
			requiredSkills: undefined,
			autoMerge: false,
			source: 'repo-ai.json',
		})
	})
})
