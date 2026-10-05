/**
 * `.repo-ai.json` against the shipped `schemas/repo-ai.json` (#67). The schema
 * is the single source of truth for the key list; this checks the subset of
 * JSON Schema it uses — top-level `type` per property (`integer` included),
 * `minimum`, `items.type` for arrays, and `additionalProperties: false` — so
 * the package needs no validator dependency.
 *
 * ponytail: no `enum` support — add it with the first property that uses one.
 */
import path from 'node:path'
import fs from 'fs-extra'
import { asLogin, asSkillList, CONFIG_FILE } from './config.js'
import { FixerAbort } from './fixer-abort.js'
import type { CheckResult } from './types.js'

interface PropertySchema {
	type: string
	minimum?: number
	items?: { type: string }
	default?: unknown
}

// ponytail: dist/base and src/base both sit two levels below the package root.
const SCHEMA_PATH = path.join(import.meta.dirname, '..', '..', 'schemas', 'repo-ai.json')
const schema: { $id: string; properties: Record<string, PropertySchema> } =
	fs.readJsonSync(SCHEMA_PATH)

export const SCHEMA_URL = schema.$id

function typeOf(value: unknown): string {
	if (Array.isArray(value)) return 'array'
	if (value === null) return 'null'
	return typeof value
}

/** One message per violation; empty when the value conforms. */
export function validateConfig(value: unknown): string[] {
	if (typeOf(value) !== 'object') return [`must be an object, got ${typeOf(value)}`]
	const errors: string[] = []
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		const prop = schema.properties[key]
		if (!prop) {
			errors.push(`unknown key "${key}"`)
			continue
		}
		const type = prop.type === 'integer' && Number.isInteger(v) ? 'integer' : typeOf(v)
		if (type !== prop.type) {
			errors.push(`"${key}" must be ${prop.type}, got ${type}`)
			continue
		}
		if (prop.minimum !== undefined && (v as number) < prop.minimum) {
			errors.push(`"${key}" must be at least ${prop.minimum}`)
		}
		const itemType = prop.items?.type
		if (itemType && (v as unknown[]).some((i) => typeOf(i) !== itemType)) {
			errors.push(`"${key}" must contain only ${itemType} items`)
		}
	}
	return errors
}

/**
 * Keys with a schema `default` that `value` leaves unset (#230), in schema
 * order. Keys with no default (`humanUser`, `maxAgents`) never appear: writing
 * one would assert a value nobody chose.
 */
export function unsetDefaults(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(schema.properties)
			.filter(([key, prop]) => prop.default !== undefined && !(key in value))
			.map(([key, prop]) => [key, prop.default])
	)
}

/** Null when there is no `.repo-ai.json` to check. */
export async function checkConfigSchema(dir: string): Promise<CheckResult | null> {
	const file = path.join(dir, CONFIG_FILE)
	const raw = await fs.readFile(file, 'utf8').catch(() => null)
	if (raw === null) return null
	let errors: string[]
	try {
		errors = validateConfig(JSON.parse(raw))
	} catch (err) {
		errors = [`not valid JSON: ${(err as Error).message}`]
	}
	if (errors.length === 0) {
		const unset = Object.entries(unsetDefaults(JSON.parse(raw)))
		if (unset.length === 0) {
			return { check: 'Loop config schema', status: 'ok', detail: `${CONFIG_FILE} is valid` }
		}
		// Valid, so never a failure — but a file showing only agentUser looked
		// complete while every tuning knob sat invisible (#230).
		return {
			check: 'Loop config schema',
			status: 'optional-missing',
			detail: `${CONFIG_FILE} is valid; unset, so on the default: ${unset.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`,
			hint: 'Run `npx @infrazero/repo-ai fix config` to write them into the file',
		}
	}
	return {
		check: 'Loop config schema',
		status: 'drift',
		detail: `${CONFIG_FILE}: ${errors.join('; ')}`,
		hint: `Keys and types: ${SCHEMA_URL}`,
	}
}

/**
 * `fix config`: stamp `$schema` into `.repo-ai.json`, first in key order, and
 * write every defaulted key the file leaves unset (#230), existing keys never
 * touched. Pinning a default means a later change to it skips this repo —
 * chosen over an invisible knob. With
 * no file yet, create one, migrating `agentUser` / `requiredSkills` once from
 * the old `.repo-tooling.json` `rules.aiLoop.agentUser` / `rules.requiredSkills`
 * (flat pre-v4 `aiLoop.agentUser` too). That file is only read, never changed;
 * nothing else reads it since #159.
 */
export async function writeConfigSchema(dir: string): Promise<string[]> {
	const file = path.join(dir, CONFIG_FILE)
	let current: Record<string, unknown>
	if (await fs.pathExists(file)) {
		const parsed = await fs.readJson(file).catch(() => null)
		if (typeOf(parsed) !== 'object') {
			throw new FixerAbort(
				'invalid-config',
				`${CONFIG_FILE} is not a JSON object`,
				'fix it by hand, then rerun'
			)
		}
		current = parsed
		if (current.$schema === SCHEMA_URL && Object.keys(unsetDefaults(current)).length === 0) {
			return []
		}
	} else {
		const old = await fs.readJson(path.join(dir, '.repo-tooling.json')).catch(() => null)
		current = {
			agentUser: asLogin(old?.rules?.aiLoop?.agentUser ?? old?.aiLoop?.agentUser),
			requiredSkills: asSkillList(old?.rules?.requiredSkills),
		}
	}
	const { $schema: _, ...rest } = current
	await fs.writeJson(file, { $schema: SCHEMA_URL, ...rest, ...unsetDefaults(rest) }, { spaces: 2 })
	return [file]
}
