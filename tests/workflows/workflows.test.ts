import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import { checkWorkflows } from '../../src/base/checks.js'
import {
	installWorkflow,
	removeRetiredWorkflow,
	RETIRED_WORKFLOWS,
	SHIPPED_WORKFLOWS,
	stampWorkflow,
	workflowsDirFor,
} from '../../src/cli/generators/workflows.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const HOOKS = ['args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow']

function source(name: string): string {
	return fs.readFileSync(join(import.meta.dirname, `../../workflows/${name}.js`), 'utf8')
}

/**
 * The Workflow tool requires `meta` as a pure literal: evaluating it with no
 * scope at all throws on any variable, and `${` would be interpolation.
 */
function readMeta(script: string) {
	const match = script.match(/^export const meta = (\{[\s\S]*?\n\})\n/)
	if (!match?.[1]) throw new Error('script does not open with `export const meta = {…}`')
	expect(match[1]).not.toContain('${')
	return new Function(`"use strict"; return (${match[1]})`)()
}

/**
 * A script is a module-shaped async body with top-level `return`, which no
 * standalone parser accepts — so compile it as the function the tool runs it as.
 */
function compile(script: string) {
	return new AsyncFunction(...HOOKS, script.replace(/^export const meta/m, 'const meta'))
}

type Run = (...hooks: unknown[]) => Promise<unknown>

/** No target set — `total` null, `remaining()` unbounded, matching the real Workflow tool. */
const UNMETERED_BUDGET = { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY }

/**
 * Run a script against stub hooks: `agent` answers from `reply`, keyed by
 * label. `budget` defaults to an unmetered stub; pass one to exercise a cap.
 */
function run(
	name: string,
	args: unknown,
	reply: (label: string) => unknown,
	budget: unknown = UNMETERED_BUDGET
) {
	const spawned: { label: string; phase: string; agentType?: string }[] = []
	const logs: string[] = []
	const prompts: string[] = []
	const agent = async (prompt: string, o: { label: string; phase: string; agentType?: string }) => {
		prompts.push(prompt)
		spawned.push({ label: o.label, phase: o.phase, agentType: o.agentType })
		return reply(o.label)
	}
	const parallel = (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map((t) => t()))
	const pipeline = (
		items: unknown[],
		...stages: ((r: unknown, i: unknown, n: number) => unknown)[]
	) =>
		Promise.all(
			items.map(async (item, n) => {
				let r: unknown = item
				for (const stage of stages) r = await stage(r, item, n)
				return r
			})
		)
	const noop = () => {}
	const log = (msg: string) => logs.push(msg)
	const result = (compile(source(name)) as Run)(
		args,
		agent,
		parallel,
		pipeline,
		noop,
		log,
		budget,
		noop
	)
	return result.then((value) => ({ value, spawned, logs, prompts }))
}

describe.each(SHIPPED_WORKFLOWS)('workflows/%s.js', (name) => {
	it('exports a literal meta named after its file', () => {
		const meta = readMeta(source(name))
		expect(meta.name).toBe(name)
		expect(meta.description).toEqual(expect.any(String))
	})

	it('declares every phase its agents run in, and no other', () => {
		const script = source(name)
		const used = new Set([...script.matchAll(/phase: '([^']+)'/g)].map((m) => m[1]))
		const declared = readMeta(script).phases.map((p: { title: string }) => p.title)
		expect(new Set(declared)).toEqual(used)
	})

	it('parses', () => {
		expect(() => compile(source(name))).not.toThrow()
	})
})

describe('ai-loop-recover', () => {
	it('runs fixes first, then reviews — the combined docs-only reviewer included', async () => {
		const { value, spawned } = await run(
			'ai-loop-recover',
			{
				fixes: [{ label: 'fix:#61', prompt: 'p' }],
				reviews: [
					{ label: 'code:#58', agentType: 'code-reviewer', prompt: 'p' },
					{ label: 'both:#59', agentType: 'general-purpose', prompt: 'p' },
				],
			},
			(label) => (label.startsWith('fix') ? { pushed: true } : { verdict: 'PASS' })
		)
		expect(spawned).toEqual([
			{ label: 'fix:#61', phase: 'Fix', agentType: undefined },
			{ label: 'code:#58', phase: 'Review', agentType: 'code-reviewer' },
			{ label: 'both:#59', phase: 'Review', agentType: 'general-purpose' },
		])
		expect(value).toEqual({
			tasks: [
				{ label: 'fix:#61', result: { pushed: true } },
				{ label: 'code:#58', result: { verdict: 'PASS' } },
				{ label: 'both:#59', result: { verdict: 'PASS' } },
			],
			outputTokensSpent: 0,
		})
	})

	it('caps at 8 tasks per tick, fixes first, and logs the rest for the next tick', async () => {
		const reviews = Array.from({ length: 9 }, (_, n) => ({ label: `code:#${n}`, prompt: 'p' }))
		const { value, spawned, logs } = await run('ai-loop-recover', { fixes: [], reviews }, () => ({
			verdict: 'PASS',
		}))
		expect(spawned.map((s) => s.label)).toEqual(reviews.slice(0, 8).map((r) => r.label))
		expect((value as { tasks: unknown[] }).tasks).toHaveLength(8)
		expect(logs.join()).toContain('code:#8')
		expect(logs.join()).toContain('8-task cap')
	})

	it('takes its task cap from args.maxTasksPerTick (#158)', async () => {
		const reviews = Array.from({ length: 4 }, (_, n) => ({ label: `code:#${n}`, prompt: 'p' }))
		const { spawned, logs } = await run(
			'ai-loop-recover',
			{ fixes: [], reviews, maxTasksPerTick: 2 },
			() => ({ verdict: 'PASS' })
		)
		expect(spawned.map((s) => s.label)).toEqual(['code:#0', 'code:#1'])
		expect(logs.join()).toContain('2-task cap')
	})

	it('stops queuing once the token budget runs out, and logs what it skipped', async () => {
		const fixes = [
			{ label: 'fix:#1', prompt: 'p' },
			{ label: 'fix:#2', prompt: 'p' },
		]
		const { spawned, logs } = await run(
			'ai-loop-recover',
			{ fixes, reviews: [], budgetTokens: 40_000 },
			() => ({ pushed: true }),
			{ total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY }
		)
		expect(spawned.map((s) => s.label)).toEqual(['fix:#1'])
		expect(logs.join()).toContain('fix:#2')
		expect(logs.join()).toContain('token budget exhausted')
	})

	it('also respects a real interactive budget target, not just the config cap', async () => {
		const fixes = [
			{ label: 'fix:#1', prompt: 'p' },
			{ label: 'fix:#2', prompt: 'p' },
		]
		const { spawned, logs } = await run(
			'ai-loop-recover',
			{ fixes, reviews: [] },
			() => ({ pushed: true }),
			{ total: 40_000, spent: () => 0, remaining: () => 40_000 }
		)
		expect(spawned.map((s) => s.label)).toEqual(['fix:#1'])
		expect(logs.join()).toContain('fix:#2')
	})
})

describe('ai-loop-pickup', () => {
	const issue = (number: number) => ({ number, title: 't', slug: `ai-${number}-x`, worktree: '/w' })

	it('reviews each opened PR with both arms, and skips review of a blocked issue', async () => {
		const { value, spawned } = await run(
			'ai-loop-pickup',
			{
				repo: 'o/r',
				agentUser: '',
				humanUser: '',
				namedReviewers: false,
				issues: [issue(1), issue(2)],
			},
			(label) =>
				label === 'impl:#1' ? { pr: 10 } : label === 'impl:#2' ? { pr: null } : { passed: true }
		)
		expect(spawned.map((s) => s.label).sort()).toEqual([
			'code-reviewer:#1',
			'impl:#1',
			'impl:#2',
			'security-expert:#1',
		])
		expect(spawned.filter((s) => s.phase === 'Review').map((s) => s.agentType)).toEqual([
			'general-purpose',
			'general-purpose',
		])
		expect(value).toEqual({
			issues: [
				{ issue: 1, pr: 10, reviews: [{ passed: true }, { passed: true }], fixRounds: 0 },
				{ issue: 2, pr: null },
			],
			outputTokensSpent: 0,
		})
	})

	it('gives each reviewer arm its own body file, so concurrent reviews never collide (#206)', async () => {
		const { prompts } = await run('ai-loop-pickup', one, (label) =>
			label === 'impl:#1' ? { pr: 10 } : { passed: true }
		)
		expect(prompts.find((p) => p.includes(':code:'))).toContain(
			'--body-file <dir>/review-10-code.md'
		)
		expect(prompts.find((p) => p.includes(':sec:'))).toContain('--body-file <dir>/review-10-sec.md')
	})

	const one = {
		repo: 'o/r',
		agentUser: '',
		humanUser: '',
		namedReviewers: false,
		issues: [issue(1)],
	}

	it('runs a fixer on CHANGES, then re-reviews the new head with both arms', async () => {
		const { value, spawned, prompts } = await run('ai-loop-pickup', one, (label) =>
			label === 'impl:#1'
				? { pr: 10 }
				: label.startsWith('fix')
					? { pushed: true }
					: { passed: label !== 'code-reviewer:#1' }
		)
		expect(spawned.map((s) => `${s.phase} ${s.label}`)).toEqual([
			'Implement impl:#1',
			'Review code-reviewer:#1',
			'Review security-expert:#1',
			'Fix fix:#1:r1',
			'Review code-reviewer:#1:r1',
			'Review security-expert:#1:r1',
		])
		expect(prompts[3]).toContain('--add-label ai-fixing')
		expect(prompts[3]).toContain('git -C "/w"')
		expect(value).toMatchObject({ issues: [{ issue: 1, pr: 10, fixRounds: 1 }] })
	})

	it('stops after 2 fix rounds of CHANGES, with no third fixer', async () => {
		const { value, spawned } = await run('ai-loop-pickup', one, (label) =>
			label === 'impl:#1'
				? { pr: 10 }
				: label.startsWith('fix')
					? { pushed: true }
					: { passed: false }
		)
		expect(spawned.filter((s) => s.phase === 'Fix').map((s) => s.label)).toEqual([
			'fix:#1:r1',
			'fix:#1:r2',
		])
		expect(spawned).toHaveLength(9)
		expect(value).toMatchObject({
			issues: [{ fixRounds: 2, reviews: [{ passed: false }, { passed: false }] }],
		})
	})

	it('takes its round cap from args.maxFixRounds (#158)', async () => {
		const { value, spawned } = await run('ai-loop-pickup', { ...one, maxFixRounds: 1 }, (label) =>
			label === 'impl:#1'
				? { pr: 10 }
				: label.startsWith('fix')
					? { pushed: true }
					: { passed: false }
		)
		expect(spawned.filter((s) => s.phase === 'Fix').map((s) => s.label)).toEqual(['fix:#1:r1'])
		expect(value).toMatchObject({ issues: [{ fixRounds: 1 }] })
	})

	it('skips the fixer past the token budget and logs it', async () => {
		const { value, spawned, logs } = await run(
			'ai-loop-pickup',
			{ ...one, budgetTokens: 120_000 },
			(label) => (label === 'impl:#1' ? { pr: 10 } : { passed: false })
		)
		expect(spawned.map((s) => s.phase)).toEqual(['Implement', 'Review', 'Review'])
		expect(logs.join()).toContain('skipped fix:#1:r1 — token budget exhausted')
		expect(value).toMatchObject({ issues: [{ fixRounds: 0 }] })
	})

	it('stops queuing past the token budget, spending it on the first issue', async () => {
		const { value, spawned, logs } = await run(
			'ai-loop-pickup',
			{
				repo: 'o/r',
				agentUser: '',
				humanUser: '',
				namedReviewers: false,
				budgetTokens: 40_000,
				issues: [issue(1), issue(2)],
			},
			(label) => (label === 'impl:#1' ? { pr: 10 } : { passed: true })
		)
		expect(spawned.map((s) => s.label)).toEqual(['impl:#1'])
		expect((value as { issues: unknown[] }).issues).toEqual([
			{ issue: 1, pr: 10, reviews: [], fixRounds: 0 },
			{ issue: 2 },
		])
		expect(logs.join()).toContain('impl:#2')
		expect(logs.join()).toContain('token budget exhausted')
	})
})

// #101: a message relayed into a running Workflow is not the agent's task.
it("tells every agent in both scripts that a relayed message isn't its task", async () => {
	const relayed = source('ai-loop-pickup').match(/const RELAYED = '([^']+)'/)?.[1] ?? ''
	expect(relayed).toContain('mid-run is not your task')
	expect(source('ai-loop-recover')).toContain(`const RELAYED = '${relayed}'`)
	const pickup = await run(
		'ai-loop-pickup',
		{
			repo: 'o/r',
			agentUser: '',
			humanUser: '',
			namedReviewers: false,
			issues: [{ number: 1, title: 't', slug: 'ai-1-x', worktree: '/w' }],
		},
		(label) => (label === 'impl:#1' ? { pr: 10 } : { passed: true })
	)
	const recover = await run(
		'ai-loop-recover',
		{
			fixes: [{ label: 'fix:#1', prompt: 'p' }],
			reviews: [{ label: 'code:#2', prompt: `p\n\n${relayed}` }],
		},
		() => ({ verdict: 'PASS' })
	)
	expect(pickup.prompts).toHaveLength(3)
	for (const p of [...pickup.prompts, ...recover.prompts]) {
		expect(p.split(relayed)).toHaveLength(2)
	}
})

describe('installWorkflow', () => {
	const setup = () => {
		const skills = join(newTmpDir(), '.claude', 'skills')
		fs.ensureDirSync(skills)
		return { skills, dir: workflowsDirFor(skills) }
	}

	it('installs beside the skills dir, stamped, then reports up-to-date', async () => {
		const { skills, dir } = setup()
		expect(dir).toBe(join(skills, '..', 'workflows'))
		expect((await installWorkflow(dir, 'ai-loop-pickup')).status).toBe('installed')
		const written = fs.readFileSync(join(dir, 'ai-loop-pickup.js'), 'utf8')
		expect(written.startsWith('export const meta = {')).toBe(true)
		expect(written).toMatch(/^\/\/ repo-ai-hash: [0-9a-f]{64}$/m)
		expect((await installWorkflow(dir, 'ai-loop-pickup')).status).toBe('up-to-date')
	})

	it('refreshes a stale pristine copy, refuses a fork, and overwrites it under force', async () => {
		const { dir } = setup()
		const file = join(dir, 'ai-loop-pickup.js')
		fs.outputFileSync(file, stampWorkflow('export const meta = {}\n', '0.0.1'))
		expect((await installWorkflow(dir, 'ai-loop-pickup')).status).toBe('updated')

		fs.appendFileSync(file, 'log("mine")\n')
		expect((await installWorkflow(dir, 'ai-loop-pickup')).status).toBe('declined-fork')
		expect((await installWorkflow(dir, 'ai-loop-pickup', { force: true })).status).toBe('updated')
	})

	it('refuses a downgrade', async () => {
		const { dir } = setup()
		fs.outputFileSync(
			join(dir, 'ai-loop-pickup.js'),
			stampWorkflow(source('ai-loop-pickup'), '999.0.0')
		)
		expect((await installWorkflow(dir, 'ai-loop-pickup')).status).toBe('declined-downgrade')
	})
})

describe('removeRetiredWorkflow (#144)', () => {
	it('removes a pristine ai-loop-pass3.js, keeps an edited one, skips an absent one', async () => {
		expect(RETIRED_WORKFLOWS).toContain('ai-loop-pass3')
		const dir = newTmpDir()
		expect((await removeRetiredWorkflow(dir, 'ai-loop-pass3')).status).toBe('absent')

		const file = join(dir, 'ai-loop-pass3.js')
		fs.outputFileSync(
			file,
			stampWorkflow("export const meta = { name: 'ai-loop-pass3' }\n", '1.1.0')
		)
		expect((await removeRetiredWorkflow(dir, 'ai-loop-pass3')).status).toBe('removed')
		expect(fs.existsSync(file)).toBe(false)

		fs.outputFileSync(
			file,
			`${stampWorkflow("export const meta = { name: 'ai-loop-pass3' }\n", '1.1.0')}mine\n`
		)
		expect((await removeRetiredWorkflow(dir, 'ai-loop-pass3')).status).toBe('kept')
	})
})

describe('checkWorkflows', () => {
	it('flags missing workflows, then passes once installed', async () => {
		const skills = join(newTmpDir(), 'skills')
		fs.ensureDirSync(skills)
		expect(await checkWorkflows(skills)).toMatchObject({ status: 'optional-missing' })
		for (const name of SHIPPED_WORKFLOWS) await installWorkflow(workflowsDirFor(skills), name)
		expect(await checkWorkflows(skills)).toMatchObject({ status: 'ok' })
	})
})
