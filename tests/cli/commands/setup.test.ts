import { join } from 'node:path'
import fs from 'fs-extra'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FixerAbort } from '../../../src/base/fixer-abort.js'
import { NOTICE, NOTICE_HASH } from '../../../src/base/notice.js'
import {
	acknowledgeNotice,
	asSetupNotes,
	quietSummary,
	runSetup,
	setupCommand,
	identityHint,
	SETUP_STEPS,
	setupSkills,
	warnDeprecatedOptions,
	type StepRun,
} from '../../../src/cli/commands/setup.js'
import { useTmpDir } from '../../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

function repo(agentUser?: string): string {
	const dir = newTmpDir()
	if (agentUser) fs.writeJsonSync(join(dir, '.repo-ai.json'), { agentUser })
	return dir
}

/** Fake steps that record the order they ran in. */
function recorder(fail: Record<string, FixerAbort> = {}) {
	const ran: string[] = []
	const step =
		(name: string): StepRun =>
		async () => {
			ran.push(name)
			if (fail[name]) throw fail[name]
			return [`${name}-file`]
		}
	const steps = Object.fromEntries(SETUP_STEPS.map((n) => [n, step(n)]))
	return { ran, steps }
}

describe('setup', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	it('runs every step under --yes, in order, with no identity step even with an agent user', async () => {
		const { ran, steps } = recorder()
		const results = await runSetup(repo('bot'), { dir: '.', yes: true }, { steps })
		expect(ran).toEqual(['config', 'claude-skills', 'allow-rules', 'labels', 'statusline'])
		expect(results.every((r) => r.status === 'applied')).toBe(true)
	})

	it('skips a step the user declines', async () => {
		const { ran, steps } = recorder()
		// Declining allow-rules (#371) leaves them as setup notes, nothing written.
		const confirm = async (t: string) => t !== 'allow-rules'
		const results = await runSetup(repo(), { dir: '.' }, { steps, confirm })
		expect(ran).toEqual(['config', 'claude-skills', 'labels', 'statusline'])
		expect(results.find((r) => r.target === 'allow-rules')?.status).toBe('skipped')
	})

	it('creates the labels without asking (#365)', async () => {
		const { ran, steps } = recorder()
		const confirm = vi.fn(async () => false)
		await runSetup(repo(), { dir: '.' }, { steps, confirm })
		expect(ran).toEqual(['labels'])
		expect(confirm.mock.calls.map(([t]) => t)).not.toContain('labels')
	})

	it('hints GH_TOKEN, not the deprecated fixer, only with an agent user (#365)', () => {
		expect(identityHint(undefined)).toBeUndefined()
		expect(identityHint('bot')).toContain('GH_TOKEN=$(gh auth token --user bot) claude')
		expect(identityHint('bot')).not.toContain('ai-loop-identity')
	})

	it('sums the label changes into one line (#365)', () => {
		const applied = [
			...['ai-ready', 'ai-wip', 'ai-review'].map((l) => `created label "${l}"`),
			'repaired label "ai-blocked"',
		]
		expect(quietSummary(applied)).toBe('created 3, repaired 1 ai-loop labels')
		expect(quietSummary(['created label "ai-ready"'])).toBe('created 1 ai-loop labels')
	})

	it('keeps going after a fixer aborts, and reports why', async () => {
		const abort = new FixerAbort('agent-identity-unavailable', 'not signed in', 'gh auth login')
		const { ran, steps } = recorder({ 'allow-rules': abort })
		const results = await runSetup(repo('bot'), { dir: '.', json: true }, { steps })
		expect(ran).toContain('statusline')
		expect(results.find((r) => r.target === 'allow-rules')).toEqual({
			target: 'allow-rules',
			status: 'failed',
			error: 'agent-identity-unavailable',
			message: 'not signed in',
			hint: 'gh auth login',
		})
	})
})

describe('setup --gh-config-dir (#365)', () => {
	it('warns that it is ignored and points at GH_TOKEN', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		warnDeprecatedOptions({ dir: '.', ghConfigDir: 'x' })
		const out = error.mock.calls.flat().join('\n')
		expect(out).toContain('--gh-config-dir is deprecated and ignored')
		expect(out).toContain('GH_TOKEN=$(gh auth token --user <agentUser>) claude')
	})

	it('says nothing without the flag', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		warnDeprecatedOptions({ dir: '.' })
		expect(error).not.toHaveBeenCalled()
	})
})

describe('setup notice', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	it('asks once, defaults to declining, and asks again when the text changes', async () => {
		const file = join(newTmpDir(), 'repo-ai', 'acknowledged')
		expect(await acknowledgeNotice({ dir: '.' }, { file, ask: async () => false })).toBe(false)
		expect(await fs.pathExists(file)).toBe(false)

		expect(await acknowledgeNotice({ dir: '.' }, { file, ask: async () => true })).toBe(true)
		const ask = vi.fn(async () => false)
		expect(await acknowledgeNotice({ dir: '.' }, { file, ask })).toBe(true)
		expect(ask).not.toHaveBeenCalled()

		fs.writeJsonSync(file, { version: '0.0.1', hash: 'old-notice' })
		expect(await acknowledgeNotice({ dir: '.' }, { file, ask })).toBe(false)
	})

	it('treats --yes as acceptance and records it', async () => {
		const file = join(newTmpDir(), 'acknowledged')
		const ask = vi.fn(async () => false)
		expect(await acknowledgeNotice({ dir: '.', yes: true }, { file, ask })).toBe(true)
		expect(ask).not.toHaveBeenCalled()
		expect(fs.readJsonSync(file).hash).toBe(NOTICE_HASH)
	})

	it('exits 1 with a hint instead of prompting when there is no terminal (#358)', async () => {
		const tty = process.stdin.isTTY
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true })
		try {
			await setupCommand({ dir: newTmpDir() })
			expect(process.exitCode).toBe(1)
			expect(error.mock.calls.flat().join('\n')).toContain('re-run with --yes')
		} finally {
			Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true })
			process.exitCode = 0
		}
	})

	it('matches the README and docs copies', () => {
		for (const f of ['README.md', 'apps/docs/docs/intro.md', 'apps/docs/docs/ai-loop.md'])
			expect(fs.readFileSync(f, 'utf8')).toContain(NOTICE)
	})
})

describe('setupSkills (#358)', () => {
	const run: StepRun = async () => ['ran']

	it('creates ~/.claude/skills and says so when Claude Code is not on PATH', async () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => {})
		const home = newTmpDir()
		const files = await setupSkills('.', { dir: '.' }, { home, hasClaude: async () => false, run })
		expect(files).toEqual(['ran'])
		expect(fs.existsSync(join(home, '.claude', 'skills'))).toBe(true)
		expect(err.mock.calls.flat().join('\n')).toContain('Claude Code not found')
	})

	it('stays quiet when Claude Code is on PATH', async () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => {})
		const home = newTmpDir()
		await setupSkills('.', { dir: '.' }, { home, hasClaude: async () => true, run })
		expect(fs.existsSync(join(home, '.claude', 'skills'))).toBe(true)
		expect(err).not.toHaveBeenCalled()
	})

	it('leaves HOME alone when --skills-dir is given', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const home = newTmpDir()
		await setupSkills(
			'.',
			{ dir: '.', skillsDir: newTmpDir() },
			{ home, hasClaude: async () => false, run }
		)
		expect(fs.existsSync(join(home, '.claude'))).toBe(false)
	})
})

describe('asSetupNotes (#369)', () => {
	it('notes what setup cannot fix, and still fails on what it can', () => {
		const out = asSetupNotes([
			{ check: 'Claude Code', status: 'missing', detail: 'claude is not on PATH' },
			{ check: 'Claude Code permissions', status: 'drift', detail: 'no "Bash(gh:*)" allow rule' },
			{
				check: 'Claude Code sandbox',
				status: 'drift',
				detail: 'sandbox is on and "gh *" is not excluded',
			},
			{ check: 'gh', status: 'missing', detail: 'gh is not on PATH' },
			{ check: 'AI loop labels', status: 'drift', detail: 'missing labels' },
		])
		expect(out.map((r) => r.status)).toEqual([
			'optional-missing',
			'optional-missing',
			'optional-missing',
			'missing',
			'drift',
		])
	})
})
