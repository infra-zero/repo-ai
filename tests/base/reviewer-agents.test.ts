import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import { checkReviewerAgents } from '../../src/base/checks.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

const agent = (dir: string, file: string, body = 'Review things.\n') =>
	fs.outputFileSync(join(dir, '.claude', 'agents', file), body)

describe('checkReviewerAgents (#364)', () => {
	it('reports the general-purpose fallback when neither agent is defined', async () => {
		const r = await checkReviewerAgents(newTmpDir(), newTmpDir())
		expect(r.status).toBe('optional-missing')
		expect(r.detail).toContain('no code-reviewer or security-expert agent')
		expect(r.detail).toContain('general-purpose')
	})

	it('names only the missing one, and finds agents in the repo and in HOME', async () => {
		const repo = newTmpDir()
		const home = newTmpDir()
		agent(repo, 'code-reviewer.md')
		expect((await checkReviewerAgents(repo, home)).detail).toMatch(/^no security-expert agent/)
		agent(home, 'nested/sec.md', '---\nname: security-expert\ndescription: x\n---\nBody.\n')
		expect(await checkReviewerAgents(repo, home)).toEqual({
			check: 'Reviewer agents',
			status: 'ok',
			detail: 'reviews run as code-reviewer and security-expert',
		})
	})

	it('goes by the frontmatter name, not the file name', async () => {
		const repo = newTmpDir()
		agent(repo, 'code-reviewer.md', '---\nname: my-reviewer\n---\n')
		agent(repo, 'security-expert.md')
		expect((await checkReviewerAgents(repo, newTmpDir())).status).toBe('optional-missing')
	})
})
