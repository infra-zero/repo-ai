/**
 * The Workflow scripts the skills run by name (#40). They used to ride inline in
 * skill prose, where nothing could lint or test them and a model could "tidy"
 * them in transit.
 *
 * Claude Code reads saved scripts from `~/.claude/workflows/` as well as a
 * project's `.claude/workflows/`, so these install user-global, beside the
 * skills that call them. Same stamps and refusal rules as the skills: a version
 * stamp to refuse a downgrade, a pristine hash to refuse overwriting a fork.
 * The stamps are trailing `//` comments, because `meta` must stay the first
 * statement of the script.
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import fs from 'fs-extra'
import { getPackageRoot } from '../utils/package-root.js'
import { isNewerVersion, resolveShippedVersion } from '../utils/version.js'
import { type SkillContentState, VERSION_KEY, HASH_KEY } from './claude-skills.js'

/** Each is `workflows/<name>.js` here, and runs as `Workflow({name})`. */
export const SHIPPED_WORKFLOWS = ['ai-loop-pickup', 'ai-loop-recover']

/**
 * Scripts a release still needs to clean up a stale copy of. `ai-workflow`
 * (folded into `ai-loop-pickup` by #87) was retired before v2 and no longer
 * needs an entry; `ai-loop-pass3` was renamed to `ai-loop-recover` in the
 * v2.0.0 release itself (#144), so v1 installs may still carry it.
 */
export const RETIRED_WORKFLOWS = ['ai-loop-pass3']

const STAMP_LINE = new RegExp(`^// (?:${VERSION_KEY}|${HASH_KEY}): .*\\n?`, 'gm')

/** `~/.claude/skills` → `~/.claude/workflows`; a `--skills-dir` gets the same sibling. */
export function workflowsDirFor(skillsDir: string): string {
	return path.join(path.dirname(skillsDir), 'workflows')
}

export function stripWorkflowStamps(content: string): string {
	return content.replace(STAMP_LINE, '')
}

export function hashWorkflowContent(content: string): string {
	return createHash('sha256').update(stripWorkflowStamps(content)).digest('hex')
}

export function stampWorkflow(content: string, version: string): string {
	const body = stripWorkflowStamps(content)
	return `${body}// ${VERSION_KEY}: ${version}\n// ${HASH_KEY}: ${hashWorkflowContent(body)}\n`
}

function readStamp(content: string, key: string): string | null {
	return content.match(new RegExp(`^// ${key}: (.+)$`, 'm'))?.[1]?.trim() ?? null
}

/** `classifySkillContent`, for a script. */
export function classifyWorkflowContent(installed: string, shipped: string): SkillContentState {
	if (stripWorkflowStamps(installed) === stripWorkflowStamps(shipped)) return 'pristine'
	const recorded = readStamp(installed, HASH_KEY)
	if (!recorded) return 'unknown'
	return recorded === hashWorkflowContent(installed) ? 'pristine' : 'modified'
}

export async function readShippedWorkflow(name: string) {
	const root = getPackageRoot()
	const file = path.join(root, 'workflows', `${name}.js`)
	const pkg = await fs.readJson(path.join(root, 'package.json'))
	return {
		content: await fs.readFile(file, 'utf8'),
		version: await resolveShippedVersion(root, String(pkg.version)),
		file,
	}
}

export interface WorkflowStatus {
	name: string
	file: string
	shippedFile: string
	installedVersion: string | null
	shippedVersion: string
	/** Null when nothing is installed. */
	contentState: SkillContentState | null
	/** What `installWorkflow` would do — and does, unless `dryRun`. */
	status: 'installed' | 'updated' | 'up-to-date' | 'declined-downgrade' | 'declined-fork'
}

/**
 * Install (or refresh) one shipped script into `dir` — see `workflowsDirFor`.
 * `dryRun` is doctor's read-only view of the same decision.
 */
export async function installWorkflow(
	dir: string,
	name: string,
	{ force = false, dryRun = false }: { force?: boolean; dryRun?: boolean } = {}
): Promise<WorkflowStatus> {
	const shipped = await readShippedWorkflow(name)
	const file = path.join(dir, `${name}.js`)
	const existing = (await fs.pathExists(file)) ? await fs.readFile(file, 'utf8') : null
	const installedVersion = existing ? readStamp(existing, VERSION_KEY) : null
	const contentState = existing === null ? null : classifyWorkflowContent(existing, shipped.content)
	const base = {
		name,
		file,
		shippedFile: shipped.file,
		installedVersion,
		shippedVersion: shipped.version,
		contentState,
	}
	if (!force && installedVersion && isNewerVersion(installedVersion, shipped.version)) {
		return { ...base, status: 'declined-downgrade' }
	}
	if (!force && contentState !== null && contentState !== 'pristine') {
		return { ...base, status: 'declined-fork' }
	}
	const next = stampWorkflow(shipped.content, shipped.version)
	if (existing === next) return { ...base, status: 'up-to-date' }
	if (!dryRun) await fs.outputFile(file, next)
	return { ...base, status: existing === null ? 'installed' : 'updated' }
}

/** `removeRetiredSkill`, for one of `RETIRED_WORKFLOWS`. */
export async function removeRetiredWorkflow(
	dir: string,
	name: string
): Promise<{ file: string; status: 'removed' | 'absent' | 'kept' }> {
	const file = path.join(dir, `${name}.js`)
	if (!(await fs.pathExists(file))) return { file, status: 'absent' }
	const content = await fs.readFile(file, 'utf8')
	if (readStamp(content, HASH_KEY) !== hashWorkflowContent(content)) return { file, status: 'kept' }
	await fs.remove(file)
	return { file, status: 'removed' }
}
