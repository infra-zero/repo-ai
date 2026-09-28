import { join } from 'node:path'
import fs from 'fs-extra'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIXERS, type FixOptions, fixCommand } from '../../../src/cli/commands/fix.js'
import { SHIPPED_SKILLS, stampSkill } from '../../../src/cli/generators/claude-skills.js'
import {
	SHIPPED_WORKFLOWS,
	stampWorkflow,
	workflowsDirFor,
} from '../../../src/cli/generators/workflows.js'
import { useTmpDir } from '../../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

/**
 * `statusline` and `ai-loop-identity` read `os.homedir()` directly rather than
 * taking a dir from FixOptions, so the real home has to be swapped out for a
 * throwaway one — otherwise a test run would write into the developer's actual
 * `~/.claude`.
 */
const { mockHome } = vi.hoisted(() => ({ mockHome: { current: '' } }))
vi.mock('node:os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:os')>()
	return {
		...actual,
		homedir: () => mockHome.current,
		default: { ...actual.default, homedir: () => mockHome.current },
	}
})

function options(dir: string, over: Partial<FixOptions> = {}): FixOptions {
	return { dir, ...over }
}

describe('fixCommand', () => {
	let logSpy: ReturnType<typeof vi.spyOn>
	let errSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		mockHome.current = newTmpDir()
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
		errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	afterEach(() => {
		process.exitCode = 0
		vi.restoreAllMocks()
	})

	it('rejects an unknown target, naming the real ones, as a red stderr line', async () => {
		await fixCommand('bogus', options(newTmpDir()))
		expect(process.exitCode).toBe(1)
		expect(errSpy.mock.calls[0]?.[0]).toContain('unknown fix target "bogus"')
		expect(errSpy.mock.calls[0]?.[0]).toContain(Object.keys(FIXERS).join(', '))
		expect(logSpy).not.toHaveBeenCalled()
	})

	it('reports an unknown target as a JSON payload on stdout instead', async () => {
		await fixCommand('bogus', options(newTmpDir(), { json: true }))
		expect(process.exitCode).toBe(1)
		expect(JSON.parse(logSpy.mock.calls[0]?.[0])).toMatchObject({
			target: 'bogus',
			error: 'unknown-target',
		})
		expect(errSpy).not.toHaveBeenCalled()
	})

	describe('config', () => {
		it('writes $schema and prints the file it touched', async () => {
			const dir = newTmpDir()
			await fixCommand('config', options(dir))
			expect(fs.readJsonSync(join(dir, '.repo-ai.json'))).toMatchObject({
				$schema: expect.stringContaining('repo-ai.json'),
			})
			expect(logSpy.mock.calls[0]?.[0]).toContain(join(dir, '.repo-ai.json'))
		})

		it('reports nothing written, in JSON, once the file already carries $schema', async () => {
			const dir = newTmpDir()
			await fixCommand('config', options(dir))
			logSpy.mockClear()
			await fixCommand('config', options(dir, { json: true }))
			expect(JSON.parse(logSpy.mock.calls[0]?.[0])).toMatchObject({
				target: 'config',
				status: 'applied',
				filesWritten: [],
			})
		})

		it('turns a FixerAbort into a JSON error payload rather than throwing', async () => {
			const dir = newTmpDir()
			fs.outputFileSync(join(dir, '.repo-ai.json'), '[]')
			await fixCommand('config', options(dir, { json: true }))
			expect(process.exitCode).toBe(1)
			expect(JSON.parse(logSpy.mock.calls[0]?.[0])).toMatchObject({
				target: 'config',
				error: 'invalid-config',
			})
		})
	})

	describe('labels', () => {
		it('is a no-op outside a git repo — no crash, nothing written', async () => {
			const dir = newTmpDir()
			await fixCommand('labels', options(dir))
			expect(errSpy.mock.calls[0]?.[0]).toContain('not a git repository')
			expect(logSpy).not.toHaveBeenCalled()
		})
	})

	describe('ai-loop-identity', () => {
		it('does nothing without a configured agentUser, and never touches the home dir', async () => {
			const dir = newTmpDir()
			await fixCommand('ai-loop-identity', options(dir))
			expect(errSpy.mock.calls[0]?.[0]).toContain('nothing to do')
			expect(fs.existsSync(join(dir, '.claude'))).toBe(false)
		})
	})

	describe('statusline', () => {
		it('installs the shipped script into the home dir and points settings at it', async () => {
			const dir = newTmpDir()
			await fixCommand('statusline', options(dir))
			const target = join(mockHome.current, '.claude', 'ai-loop-statusline.sh')
			expect(fs.existsSync(target)).toBe(true)
			expect(logSpy.mock.calls.map((c) => c[0]).join('\n')).toContain(target)
		})
	})

	describe('claude-skills', () => {
		it('installs every shipped skill and workflow under an explicit --skills-dir', async () => {
			const dir = newTmpDir()
			const skillsDir = newTmpDir()
			await fixCommand('claude-skills', options(dir, { skillsDir, yes: true }))
			for (const name of SHIPPED_SKILLS) {
				expect(fs.existsSync(join(skillsDir, name, 'SKILL.md'))).toBe(true)
			}
			for (const name of SHIPPED_WORKFLOWS) {
				expect(fs.existsSync(join(workflowsDirFor(skillsDir), `${name}.js`))).toBe(true)
			}
		})

		it('removes a pristine retired skill and a pristine retired workflow (#87)', async () => {
			const dir = newTmpDir()
			const skillsDir = newTmpDir()
			fs.outputFileSync(
				join(skillsDir, 'ai-workflow', 'SKILL.md'),
				stampSkill('---\nname: ai-workflow\n---\nbody\n', '1.0.0')
			)
			fs.outputFileSync(
				join(workflowsDirFor(skillsDir), 'ai-workflow.js'),
				stampWorkflow('old script\n', '1.0.0')
			)
			await fixCommand('claude-skills', options(dir, { skillsDir, yes: true }))
			expect(fs.existsSync(join(skillsDir, 'ai-workflow'))).toBe(false)
			expect(fs.existsSync(join(workflowsDirFor(skillsDir), 'ai-workflow.js'))).toBe(false)
			const errors = errSpy.mock.calls.map((c) => c[0]).join('\n')
			expect(errors).toContain('removed retired')
		})

		it('keeps a retired skill that was locally edited instead of removing it', async () => {
			const dir = newTmpDir()
			const skillsDir = newTmpDir()
			fs.outputFileSync(
				join(skillsDir, 'ai-tick', 'SKILL.md'),
				`${stampSkill('---\nname: ai-tick\n---\nbody\n', '1.0.0')}mine\n`
			)
			await fixCommand('claude-skills', options(dir, { skillsDir, yes: true }))
			expect(fs.existsSync(join(skillsDir, 'ai-tick', 'SKILL.md'))).toBe(true)
			const errors = errSpy.mock.calls.map((c) => c[0]).join('\n')
			expect(errors).toContain('modified or symlinked')
		})

		it('aborts as a JSON error when --yes is given but there is nowhere to install', async () => {
			const dir = newTmpDir()
			// mockHome.current has no ~/.claude/skills, and no --skills-dir is given.
			await fixCommand('claude-skills', options(dir, { yes: true, json: true }))
			expect(process.exitCode).toBe(1)
			expect(JSON.parse(logSpy.mock.calls[0]?.[0])).toMatchObject({
				target: 'claude-skills',
				error: 'no-skills-dir',
			})
		})
	})
})
