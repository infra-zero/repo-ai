import type { CommentOwed } from '../cli/commands/loop-apply.js'

/**
 * The decision comments `loop apply` owes (#282), written without an agent.
 * The skill excerpts a failing log into a send-back; here the fixer is told
 * where to read it instead, so no untrusted log bytes are ever re-posted.
 */
export function commentText(c: CommentOwed, defaultBranch: string): string {
	const head = (who: string) => `🤖 *Automated — \`ai-loop\` ${who}.*\n`
	switch (c.kind) {
		case 'notes':
			return `${head('handoff')}
Both reviews passed, with notes: read the reviewer's \`### Before merging\` above before you merge.`
		case 'send-back': {
			const s = c.sendBack
			if (s.reason === 'DIRTY')
				return `${head('send-back')}
Merge \`${defaultBranch}\` into this branch and push — never rebase or force-push. The branch conflicts with \`${defaultBranch}\`.`
			const lines = [`${head('send-back')}`, 'Make the required checks pass, then push.', '']
			for (const f of s.failing) lines.push(`- \`${f.name}\` failed: ${f.link}`)
			for (const m of s.missing ?? [])
				lines.push(
					`- required check \`${m}\` never reported — the PR may have removed or renamed that job (the fix may be branch protection, not code)`
				)
			if (s.failing.length)
				lines.push(
					'',
					'Read the failures with `gh pr checks` and `gh run view <run-id> --log-failed`.'
				)
			return lines.join('\n')
		}
		case 'blocked': {
			const s = c.stall
			return `${head('Pass 2 (stall reaping)')}
Blocked: ${s.reason}.${s.label ? ` \`${s.label}\` sat ${s.minutes ?? '?'} minutes.` : ''}${
				s.worktree ? ' The worktree was removed.' : ''
			} Re-add \`ai-ready\` to try again.`
		}
		case 'round-cap':
			return `${head('Pass 3')}
Blocked after ${c.fixRound.applications} rounds of review changes: ${c.fixRound.reason}. The worktree and PR are left for you.`
	}
}
