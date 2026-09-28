import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import type { GhExec, GhResult } from '../../src/base/gh.js'
import { releaseGated } from '../../src/base/release-gate.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

const ok = (stdout: string): GhResult => ({ ok: true, stdout, stderr: '', code: 0 })
const notFound: GhResult = { ok: false, stdout: '', stderr: '404 Not Found', code: 1 }
const notFoundGh: GhExec = async () => notFound

function writeWorkflow(dir: string, name: string, content: string): void {
	fs.outputFileSync(join(dir, '.github', 'workflows', name), content)
}

const RELEASE_JOB =
	'jobs:\n  release:\n    environment: release\n    steps:\n      - run: npx semantic-release\n'

/** Serves `gh api repos/{nwo}/environments`. */
function envs(list: Array<{ name: string; requiredReviewers: boolean }>): GhExec {
	return async () =>
		ok(
			JSON.stringify({
				environments: list.map((e) => ({
					name: e.name,
					protection_rules: e.requiredReviewers ? [{ type: 'required_reviewers' }] : [],
				})),
			})
		)
}

describe('releaseGated (#620)', () => {
	it('is false with no .github/workflows at all', async () => {
		expect(await releaseGated(notFoundGh, 'acme/x', newTmpDir())).toBe(false)
	})

	it('is false when no workflow runs a publish command', async () => {
		const dir = newTmpDir()
		writeWorkflow(dir, 'ci.yml', 'jobs:\n  test:\n    steps:\n      - run: pnpm test\n')
		expect(await releaseGated(notFoundGh, 'acme/x', dir)).toBe(false)
	})

	it('ignores a publish command mentioned only in a comment (no false positive)', async () => {
		const dir = newTmpDir()
		writeWorkflow(
			dir,
			'ci.yml',
			'jobs:\n  varcheck:\n    # npm publish uses OIDC trusted publishing\n    steps:\n      - run: echo ok\n'
		)
		expect(await releaseGated(notFoundGh, 'acme/x', dir)).toBe(false)
	})

	it('is false when the publish job declares no environment', async () => {
		const dir = newTmpDir()
		writeWorkflow(
			dir,
			'release.yml',
			'jobs:\n  release:\n    steps:\n      - run: npx semantic-release\n'
		)
		expect(await releaseGated(notFoundGh, 'acme/x', dir)).toBe(false)
	})

	it('reads the block form of environment: (name: on the next line)', async () => {
		const dir = newTmpDir()
		writeWorkflow(
			dir,
			'release.yml',
			'jobs:\n  release:\n    environment:\n      name: release\n    steps:\n      - run: npx semantic-release\n'
		)
		const gh = envs([{ name: 'release', requiredReviewers: true }])
		expect(await releaseGated(gh, 'acme/x', dir)).toBe(true)
	})

	it('is false when the repo has no environments at all (404 reads as none, not unreadable)', async () => {
		const dir = newTmpDir()
		writeWorkflow(dir, 'release.yml', RELEASE_JOB)
		expect(await releaseGated(notFoundGh, 'acme/x', dir)).toBe(false)
	})

	it('is false when the named environment carries no required_reviewers rule', async () => {
		const dir = newTmpDir()
		writeWorkflow(dir, 'release.yml', RELEASE_JOB)
		const gh = envs([{ name: 'release', requiredReviewers: false }])
		expect(await releaseGated(gh, 'acme/x', dir)).toBe(false)
	})

	it('is true when the publish job runs behind an environment with required_reviewers', async () => {
		const dir = newTmpDir()
		writeWorkflow(dir, 'release.yml', RELEASE_JOB)
		const gh = envs([{ name: 'release', requiredReviewers: true }])
		expect(await releaseGated(gh, 'acme/x', dir)).toBe(true)
	})

	it('fails closed when the environments API errors instead of answering 404', async () => {
		const dir = newTmpDir()
		writeWorkflow(dir, 'release.yml', RELEASE_JOB)
		const gh: GhExec = async () => ({ ok: false, stdout: '', stderr: 'HTTP 500', code: 1 })
		expect(await releaseGated(gh, 'acme/x', dir)).toBe(false)
	})

	it('fails closed when the environments API answers unparseable JSON', async () => {
		const dir = newTmpDir()
		writeWorkflow(dir, 'release.yml', RELEASE_JOB)
		const gh: GhExec = async () => ok('not json')
		expect(await releaseGated(gh, 'acme/x', dir)).toBe(false)
	})

	it('fails closed when a workflow file cannot be read', async () => {
		const dir = newTmpDir()
		const workflowsDir = join(dir, '.github', 'workflows')
		// A directory named like a workflow file: readFile on it throws EISDIR,
		// the same "unreadable" shape as a permission error or broken symlink.
		fs.ensureDirSync(join(workflowsDir, 'broken.yml'))
		const gh = envs([{ name: 'release', requiredReviewers: true }])
		expect(await releaseGated(gh, 'acme/x', dir)).toBe(false)
	})
})
