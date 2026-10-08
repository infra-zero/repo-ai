export type Snapshot = {
	/** Open items per ai-* label. */
	counts: Record<string, number>
	/** First line of .claude/ai-loop-status, or null when the file is absent. */
	loop: string | null
	/** Seconds since the status file's timestamp, or null. */
	loopAge: number | null
}

declare module 'claude-code' {
	interface PluginState {
		'repo-ai-rainbow': { snapshot: Snapshot | null }
	}
}
