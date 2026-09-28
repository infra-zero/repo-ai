import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'

/**
 * `@me` resolves to whichever token `gh` is running as, which the Pass 0
 * identity check now *requires* to be the agent account whenever one is
 * declared — so every `--add-assignee @me` handed work back to the machine that
 * had just given up on it (#606). The human is named via the tick's `humanUser` instead.
 */
const skills = ['ai-loop'].map((n) => join(import.meta.dirname, `../../skills/${n}/SKILL.md`))

describe('ai loop skills never assign @me (#606)', () => {
	it.each(skills)('%s uses no @me as an assignee', (path) => {
		const offenders = fs
			.readFileSync(path, 'utf8')
			.split('\n')
			.filter((line) => /assignee\s+"?@me/.test(line))
		expect(offenders).toEqual([])
	})

	it('ai-loop reads its values from the tick, never an eval of `loop env` (#150)', () => {
		const skill = fs.readFileSync(skills[0], 'utf8')
		// No allow rule can match an eval, so it sent every first step to the classifier.
		expect(skill).not.toMatch(/\beval\b/)
		expect(skill).toContain('npx @rtorcato/repo-ai loop tick --json\n')
		// The values come from the tick's `.env`, written in as `<name>` placeholders.
		expect(skill).not.toMatch(
			/\$\{?(ROOT|WT_ROOT|OWNER_REPO|AGENT_USER|HUMAN_USER|ME|BUDGET_TOKENS|QUIET_STOP_MINUTES)\b/
		)
		expect(skill).toContain('--add-assignee <humanUser>')
	})

	/**
	 * Dropping an empty user's assignee flag keeps the name out, but says
	 * nothing about the command as a whole: a `gh … edit <N>` whose only flags
	 * are conditional collapses to zero flags when every one of them is empty,
	 * and gh exits non-zero on that. A trailing "# skip when both are empty"
	 * comment is not enforcement — the reader is an agent following prose.
	 */
	it('no gh edit snippet can collapse to zero flags', () => {
		const lines = fs.readFileSync(skills[0], 'utf8').split('\n')
		const bare = lines.filter((line, i) => {
			// Match anywhere on the line, not just at its start: these commands also
			// appear inside markdown table cells (`| … |`) and blockquoted prompts
			// (`> …`), where a start-anchored pattern would silently skip them.
			const at = /gh (pr|issue) edit <[NM]>/.exec(line)
			if (!at) return false
			// A `#` before the match means prose about the command, not the command.
			if (line.slice(0, at.index).includes('#')) return false
			let cmd = line.slice(at.index)
			const inlineEnd = cmd.indexOf('`')
			if (inlineEnd !== -1) cmd = cmd.slice(0, inlineEnd)
			// Join the snippet's continuation lines into one logical command.
			for (let j = i; cmd.trimEnd().endsWith('\\') && j + 1 < lines.length; j++) {
				cmd = `${cmd.trimEnd().slice(0, -1)} ${lines[j + 1].replace(/^[\s>|]*/, '').trim()}`
			}
			// An assignee flag drops out when its user is empty (#150).
			const withoutConditionals = cmd.replace(
				/--(add|remove)-assignee <(agentUser|humanUser)>/g,
				''
			)
			const hasUnconditionalFlag = /\s--[a-z-]+/.test(withoutConditionals)
			if (hasUnconditionalFlag) return false
			// Otherwise the prose just before it must guard on that user being set.
			const before = [...lines.slice(Math.max(0, i - 2), i), line.slice(0, at.index)].join(' ')
			return !/when `(agentUser|humanUser)` is set/.test(before)
		})
		expect(bare).toEqual([])
	})
})
