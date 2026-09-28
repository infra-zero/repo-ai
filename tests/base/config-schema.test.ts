import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import {
	checkConfigSchema,
	SCHEMA_URL,
	validateConfig,
	writeConfigSchema,
} from '../../src/base/config-schema.js'
import { FixerAbort } from '../../src/base/fixer-abort.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

describe('validateConfig', () => {
	it('accepts every known key with the right type', () => {
		expect(
			validateConfig({ $schema: SCHEMA_URL, agentUser: 'bot', requiredSkills: ['ai-loop'] })
		).toEqual([])
	})

	it('rejects unknown keys, wrong types, and non-string skills', () => {
		expect(validateConfig({ agentUsr: 'bot' })).toEqual(['unknown key "agentUsr"'])
		expect(validateConfig({ agentUser: 1 })).toEqual(['"agentUser" must be string, got number'])
		expect(validateConfig({ requiredSkills: ['a', 2] })).toEqual([
			'"requiredSkills" must contain only string items',
		])
		expect(validateConfig([])).toEqual(['must be an object, got array'])
		expect(validateConfig({ pollSeconds: 90.5 })).toEqual([
			'"pollSeconds" must be integer, got number',
		])
		expect(validateConfig({ pollSeconds: 30 })).toEqual(['"pollSeconds" must be at least 60'])
		expect(validateConfig({ pollSeconds: 120 })).toEqual([])
		expect(validateConfig({ budgetTokens: 500 })).toEqual(['"budgetTokens" must be at least 1000'])
		expect(validateConfig({ budgetTokens: 200_000 })).toEqual([])
		expect(validateConfig({ quietStopMinutes: 0 })).toEqual([])
		expect(validateConfig({ quietStopMinutes: -1 })).toEqual([
			'"quietStopMinutes" must be at least 0',
		])
	})
})

describe('checkConfigSchema', () => {
	it('is silent with no .repo-ai.json, ok with a valid one', async () => {
		const dir = newTmpDir()
		expect(await checkConfigSchema(dir)).toBeNull()
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { agentUser: 'bot' })
		expect((await checkConfigSchema(dir))?.status).toBe('ok')
	})

	it('flags a typo and unparseable JSON as drift', async () => {
		const dir = newTmpDir()
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { agentUsr: 'bot' })
		expect(await checkConfigSchema(dir)).toMatchObject({ status: 'drift' })
		fs.outputFileSync(join(dir, '.repo-ai.json'), '{ nope')
		expect((await checkConfigSchema(dir))?.detail).toMatch(/not valid JSON/)
	})
})

describe('writeConfigSchema', () => {
	it('puts $schema first in an existing file, and is idempotent', async () => {
		const dir = newTmpDir()
		const file = join(dir, '.repo-ai.json')
		fs.outputJsonSync(file, { agentUser: 'bot', $schema: 'old' })
		expect(await writeConfigSchema(dir)).toEqual([file])
		expect(Object.entries(fs.readJsonSync(file))).toEqual([
			['$schema', SCHEMA_URL],
			['agentUser', 'bot'],
		])
		expect(await writeConfigSchema(dir)).toEqual([])
	})

	it('creates the file, migrating .repo-tooling.json settings and leaving it alone', async () => {
		const dir = newTmpDir()
		const old = { rules: { aiLoop: { agentUser: 'legacy-bot' }, requiredSkills: ['ai-loop'] } }
		fs.outputJsonSync(join(dir, '.repo-tooling.json'), old)
		await writeConfigSchema(dir)
		expect(fs.readJsonSync(join(dir, '.repo-ai.json'))).toEqual({
			$schema: SCHEMA_URL,
			agentUser: 'legacy-bot',
			requiredSkills: ['ai-loop'],
		})
		expect(fs.readJsonSync(join(dir, '.repo-tooling.json'))).toEqual(old)
	})

	it('refuses to overwrite a file that is not a JSON object', async () => {
		const dir = newTmpDir()
		fs.outputFileSync(join(dir, '.repo-ai.json'), '{ nope')
		await expect(writeConfigSchema(dir)).rejects.toBeInstanceOf(FixerAbort)
		expect(fs.readFileSync(join(dir, '.repo-ai.json'), 'utf8')).toBe('{ nope')
	})
})
