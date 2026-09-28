import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import { checkRequiredSkills } from '../../src/base/checks.js'
import { readShippedSkill, stampSkill } from '../../src/cli/generators/claude-skills.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

/** Write `content` where `claudeSkillStatus(name, dir)` will look for it. */
async function install(dir: string, name: string, content: string): Promise<void> {
	await fs.outputFile(join(dir, name, 'SKILL.md'), content)
}

describe('checkRequiredSkills (#533)', () => {
	it('reports a skill that is not installed, without ever failing the exit code', async () => {
		const r = await checkRequiredSkills(['ai-loop', 'ai-issue'], newTmpDir())
		// The whole point of the severity rule: a contributor with no Claude
		// installed must not fail this repo's doctor.
		expect(r.status).toBe('optional-missing')
		expect(r.detail).toContain('not installed: ai-loop, ai-issue')
		expect(r.hint).toContain('fix claude-skills')
	})

	it('is ok when the installed copy is what this package ships', async () => {
		const dir = newTmpDir()
		const shipped = await readShippedSkill('ai-loop')
		await install(dir, 'ai-loop', stampSkill(shipped.content, shipped.version))

		const r = await checkRequiredSkills(['ai-loop'], dir)
		expect(r.status).toBe('ok')
		expect(r.detail).toContain('ai-loop')
	})

	// The failure this check exists for: an older copy runs to completion without
	// complaint, so nothing but a version comparison ever notices.
	it('reports a stale copy — pristine content, older stamp', async () => {
		const dir = newTmpDir()
		const shipped = await readShippedSkill('ai-loop')
		await install(dir, 'ai-loop', stampSkill(shipped.content, '0.0.1'))

		const r = await checkRequiredSkills(['ai-loop'], dir)
		expect(r.status).toBe('optional-missing')
		expect(r.detail).toContain('ai-loop is stale')
		expect(r.detail).toContain('0.0.1')
		expect(r.detail).toContain(shipped.version)
	})

	// Mirrors the assets model (#428): content matching no shipped version is
	// somebody's fork, and `fix claude-skills` refuses it without --force-skills.
	it('reports a copy whose hash matches no shipped version as modified', async () => {
		const dir = newTmpDir()
		const shipped = await readShippedSkill('ai-loop')
		await install(dir, 'ai-loop', `${stampSkill(shipped.content, shipped.version)}\nlocal edit\n`)

		const r = await checkRequiredSkills(['ai-loop'], dir)
		expect(r.status).toBe('optional-missing')
		expect(r.detail).toContain('matches no version this package has shipped')
		expect(r.hint).toContain('--force-skills')
	})

	it('names a skill this package does not ship instead of throwing on the missing asset', async () => {
		const r = await checkRequiredSkills(['ai-loop', 'not-a-skill'], newTmpDir())
		expect(r.status).toBe('optional-missing')
		expect(r.detail).toContain('not-a-skill')
		expect(r.hint).toContain('ai-loop')
	})
})
