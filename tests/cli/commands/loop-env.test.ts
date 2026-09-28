import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import type { GhExec } from '../../../src/base/gh.js'
import { resolveLoopEnv, toShell } from '../../../src/cli/commands/loop-env.js'
import { useTmpDir } from '../../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
		.toString()
		.trim()

function checkout(parent: string): string {
	const dir = join(parent, 'repo')
	fs.ensureDirSync(dir)
	git(dir, 'init', '-q', '-b', 'main')
	git(dir, 'config', 'user.email', 'test@example.com')
	git(dir, 'config', 'user.name', 'Test')
	fs.writeFileSync(join(dir, 'README.md'), '# test\n')
	git(dir, 'add', '-A')
	git(dir, 'commit', '-qm', 'init')
	return fs.realpathSync(dir)
}

/** Answers by the first arg that names a route; records every call. */
function fakeGh(
	opts: { owner?: 'User' | 'Organization'; assignable?: string[]; defaultBranch?: string } = {}
) {
	const calls: string[][] = []
	const gh: GhExec = async (args) => {
		calls.push(args)
		const ok = (stdout: string) => ({ ok: true, stdout, stderr: '' })
		if (args[0] === 'repo' && args.includes('defaultBranchRef'))
			return ok(`${opts.defaultBranch ?? 'main'}\n`)
		if (args[0] === 'repo') return ok('acme/widget\n')
		const route = args[1]
		if (route === 'user') return ok('me-bot\n')
		if (route === 'repos/acme/widget') return ok(opts.owner === 'Organization' ? '\n' : 'acme\n')
		const m = route?.match(/^repos\/acme\/widget\/assignees\/(.+)$/)
		if (m && opts.assignable?.includes(m[1] as string)) return ok('')
		return { ok: false, stdout: '', stderr: 'HTTP 404' }
	}
	return { gh, calls }
}

describe('resolveLoopEnv', () => {
	it('resolves ROOT to the main checkout from inside a linked worktree', async () => {
		const tmp = newTmpDir()
		const root = checkout(tmp)
		const wt = join(tmp, 'repo-worktrees', 'ai-1')
		git(root, 'worktree', 'add', '-q', wt, '-b', 'ai-1')
		const env = await resolveLoopEnv({ dir: wt, gh: fakeGh().gh, env: {} })
		expect(env.root).toBe(root)
		expect(env.worktreeRoot).toBe(`${root}-worktrees`)
		expect(env).toMatchObject({ ownerRepo: 'acme/widget', humanUser: 'acme', me: 'me-bot' })
	})

	it('reads agentUser and keeps it when assignable', async () => {
		const root = checkout(newTmpDir())
		fs.writeJsonSync(join(root, '.repo-ai.json'), { agentUser: 'bot' })
		const env = await resolveLoopEnv({ dir: root, gh: fakeGh({ assignable: ['bot'] }).gh, env: {} })
		expect(env.agentUser).toBe('bot')
		expect(env.warnings).toEqual([])
	})

	it('lets AI_LOOP_AGENT override the config', async () => {
		const root = checkout(newTmpDir())
		fs.writeJsonSync(join(root, '.repo-ai.json'), { agentUser: 'bot' })
		const { gh } = fakeGh({ assignable: ['bot', 'other'] })
		const env = await resolveLoopEnv({ dir: root, gh, env: { AI_LOOP_AGENT: 'other' } })
		expect(env.agentUser).toBe('other')
	})

	it('drops an unassignable agentUser to empty, with a warning', async () => {
		const root = checkout(newTmpDir())
		const env = await resolveLoopEnv({ dir: root, gh: fakeGh().gh, env: { AI_LOOP_AGENT: 'typo' } })
		expect(env.agentUser).toBe('')
		expect(env.warnings.join()).toMatch(/not an assignable collaborator/)
	})

	it('never puts an invalid login into an API path', async () => {
		const root = checkout(newTmpDir())
		const { gh, calls } = fakeGh()
		const env = await resolveLoopEnv({ dir: root, gh, env: { AI_LOOP_AGENT: '../../x' } })
		expect(env.agentUser).toBe('')
		expect(calls.some((c) => c.join(' ').includes('assignees'))).toBe(false)
	})

	it('defaults BUDGET_TOKENS, and reads a configured cap', async () => {
		const root = checkout(newTmpDir())
		expect((await resolveLoopEnv({ dir: root, gh: fakeGh().gh, env: {} })).budgetTokens).toBe(
			400_000
		)
		fs.writeJsonSync(join(root, '.repo-ai.json'), { budgetTokens: 50_000 })
		expect((await resolveLoopEnv({ dir: root, gh: fakeGh().gh, env: {} })).budgetTokens).toBe(
			50_000
		)
	})

	it('exports each loop limit: default, override, and invalid fallback (#158)', async () => {
		const root = checkout(newTmpDir())
		const limits = async () => {
			const e = await resolveLoopEnv({ dir: root, gh: fakeGh().gh, env: {} })
			return [
				e.maxInFlight,
				e.maxFixRounds,
				e.maxTasksPerTick,
				e.staleMinutes,
				e.busyMinutes,
				e.idleMinutes,
			]
		}
		expect(await limits()).toEqual([6, 2, 8, 45, 10, 30])
		fs.writeJsonSync(join(root, '.repo-ai.json'), {
			maxInFlight: 3,
			maxFixRounds: 0,
			maxTasksPerTick: 4,
			staleMinutes: 90,
			busyMinutes: 5,
			idleMinutes: 60,
		})
		expect(await limits()).toEqual([3, 0, 4, 90, 5, 60])
		fs.writeJsonSync(join(root, '.repo-ai.json'), {
			maxInFlight: 0,
			maxFixRounds: -1,
			maxTasksPerTick: '4',
			staleMinutes: 0,
			busyMinutes: null,
			idleMinutes: 0,
		})
		expect(await limits()).toEqual([6, 2, 8, 45, 10, 30])
	})

	it('defaults QUIET_STOP_MINUTES to 120, and reads a configured 0', async () => {
		const root = checkout(newTmpDir())
		expect((await resolveLoopEnv({ dir: root, gh: fakeGh().gh, env: {} })).quietStopMinutes).toBe(
			120
		)
		fs.writeJsonSync(join(root, '.repo-ai.json'), { quietStopMinutes: 0 })
		expect((await resolveLoopEnv({ dir: root, gh: fakeGh().gh, env: {} })).quietStopMinutes).toBe(0)
	})

	it('leaves HUMAN_USER empty for an organisation repo', async () => {
		const root = checkout(newTmpDir())
		const env = await resolveLoopEnv({
			dir: root,
			gh: fakeGh({ owner: 'Organization' }).gh,
			env: {},
		})
		expect(env.humanUser).toBe('')
	})

	it('humanUser in .repo-ai.json overrides the owner-based default (#162)', async () => {
		const root = checkout(newTmpDir())
		fs.writeJsonSync(join(root, '.repo-ai.json'), { humanUser: 'org-owner' })
		const env = await resolveLoopEnv({
			dir: root,
			gh: fakeGh({ owner: 'Organization' }).gh,
			env: {},
		})
		expect(env.humanUser).toBe('org-owner')
	})

	it('reports an unresolvable checkout and repo as empty', async () => {
		const dir = newTmpDir()
		const gh: GhExec = async () => ({ ok: false, stdout: '', stderr: 'no repo' })
		const env = await resolveLoopEnv({ dir, gh, git: async () => null, env: {} })
		expect(env).toMatchObject({
			root: '',
			worktreeRoot: '',
			ownerRepo: '',
			defaultBranch: '',
			me: '',
		})
		expect(env.warnings).toHaveLength(3)
	})

	it('resolves a non-main default branch, and reads it from origin/HEAD over gh', async () => {
		const root = checkout(newTmpDir())
		git(root, 'remote', 'add', 'origin', 'https://example.invalid/acme/widget.git')
		git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
		const env = await resolveLoopEnv({
			dir: root,
			gh: fakeGh({ defaultBranch: 'master' }).gh,
			env: {},
		})
		// origin/HEAD (trunk) wins over what gh would have said (master).
		expect(env.defaultBranch).toBe('trunk')
	})

	it('falls back to gh for the default branch when origin/HEAD is unset', async () => {
		const root = checkout(newTmpDir())
		const env = await resolveLoopEnv({
			dir: root,
			gh: fakeGh({ defaultBranch: 'master' }).gh,
			env: {},
		})
		expect(env.defaultBranch).toBe('master')
		expect(env.warnings).toEqual([])
	})
})

describe('toShell', () => {
	it('single-quotes values so eval cannot be injected', () => {
		const out = toShell({
			root: "/a'b",
			worktreeRoot: '/w',
			ownerRepo: 'o/r',
			defaultBranch: 'main',
			agentUser: '',
			humanUser: 'h',
			me: '$(id)',
			budgetTokens: 400_000,
			quietStopMinutes: 120,
			maxInFlight: 6,
			maxFixRounds: 2,
			maxTasksPerTick: 8,
			staleMinutes: 45,
			busyMinutes: 10,
			idleMinutes: 30,
			warnings: [],
		})
		expect(out).toContain(`ROOT='/a'\\''b'`)
		expect(out).toContain(`DEFAULT_BRANCH='main'`)
		expect(out).toContain(`ME='$(id)'`)
		expect(out).toContain(`AGENT_USER=''`)
		expect(out).toContain(`BUDGET_TOKENS='400000'`)
		expect(out).toContain(`QUIET_STOP_MINUTES='120'`)
		expect(out).toContain(`MAX_FIX_ROUNDS='2'`)
		expect(out).toContain(`IDLE_MINUTES='30'`)
	})
})
