import type { ReactNode } from 'react'
import type { DaemonConfig, DashboardView } from '~/lib/api'
import { SaveBar, useConfigForm } from './config-form'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Input } from './ui/input'
import { Select } from './ui/select'
import { Switch } from './ui/switch'

type Models = NonNullable<DaemonConfig['models']>
type Runner = keyof Models
type Model = NonNullable<Models[Runner]>
type Mcp = NonNullable<Model['mcp']>[number]
type RunnerInfo = DashboardView['runners'][number]

const LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' }
const lines = (v?: string[]) => (v ?? []).join('\n')
const split = (s: string) => s.split('\n')
const tidy = (v?: string[]) => {
	const x = v?.map((t) => t.trim()).filter(Boolean)
	return x?.length ? x : undefined
}

/** Textareas keep blank lines while typing; they go on save. */
const clean = (d: DaemonConfig): DaemonConfig => ({
	...d,
	models: Object.fromEntries(
		Object.entries(d.models ?? {}).map(([r, m]) => [
			r,
			{
				...m,
				models: tidy(m?.models),
				tools: tidy(m?.tools),
				mcp: m?.mcp?.map((s) => ({ ...s, args: tidy(s.args), env: tidy(s.env) })),
			},
		])
	),
})

/** Is `name` a credential of this runner, bare or suffixed for an account? */
const ofRunner = (r: RunnerInfo, name: string) =>
	r.auth.some((a) => name === a || name.startsWith(`${a}_`))

/** One card per runner (#306): status, models, tools, accounts, MCP servers. Names only, never values. */
export function Models({ view }: { view: DashboardView }) {
	const form = useConfigForm(view, clean)
	const { draft, edit } = form
	// MCP access is per agent (#307), not per worker slot.
	const agentIds = draft.agents.map((a) => a.id).sort()
	return (
		<div className="flex max-w-4xl flex-col gap-4">
			<p className="text-sm text-muted-foreground">
				Credential values stay in <code>docker/.env</code>; this page only names them. An agent
				profile's model and tools override its runner's defaults.
			</p>
			{view.runners.map((r) => (
				<RunnerCard
					key={r.name}
					r={r}
					view={view}
					m={draft.models?.[r.name as Runner] ?? {}}
					agentIds={agentIds}
					set={(patch) =>
						edit((d) => ({
							...d,
							models: { ...d.models, [r.name]: { ...d.models?.[r.name as Runner], ...patch } },
						}))
					}
				/>
			))}
			<SaveBar form={form} />
		</div>
	)
}

function RunnerCard({
	r,
	view,
	m,
	agentIds,
	set,
}: {
	r: RunnerInfo
	view: DashboardView
	m: Model
	agentIds: string[]
	set: (patch: Partial<Model>) => void
}) {
	const present = view.credentials.filter((c) => ofRunner(r, c))
	const workers = view.workers.filter((w) => (w.runner ?? 'claude') === r.name)
	const accounts = m.accounts ?? []
	const mcp = m.mcp ?? []
	const setAccount = (i: number, patch: Partial<(typeof accounts)[number]>) =>
		set({ accounts: accounts.map((a, j) => (j === i ? { ...a, ...patch } : a)) })
	const setMcp = (i: number, patch: Partial<Mcp>) =>
		set({ mcp: mcp.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
	return (
		<Card>
			<CardHeader>
				<CardTitle>{LABEL[r.name] ?? r.name}</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-5 text-sm">
				<Section title="Status">
					<Row label="Needs one of">
						{r.auth.map((a) => (
							<Badge key={a} variant="outline" className="font-mono">
								{a}
							</Badge>
						))}
					</Row>
					<Row label="On the api">
						{present.map((c) => (
							<Badge key={c} variant="success" className="font-mono">
								{c}
							</Badge>
						))}
						{present.length === 0 && <Badge variant="muted">none</Badge>}
					</Row>
					<Row label="Workers">
						{workers.map((w) => (
							<Badge
								key={w.id}
								variant={w.claudeAuth ? 'success' : 'warning'}
								className="font-mono"
							>
								{w.id}
								{w.claudeAuth ? '' : ' · no own credential'}
							</Badge>
						))}
						{workers.length === 0 && <Badge variant="muted">none running {r.name}</Badge>}
					</Row>
				</Section>

				<Section title="Models">
					<div className="flex flex-wrap gap-4 text-xs">
						<label className="flex flex-col gap-1">
							<span className="text-muted-foreground">Available, one per line</span>
							<textarea
								aria-label={`${r.name} models`}
								rows={3}
								value={lines(m.models)}
								onChange={(e) => set({ models: split(e.target.value) })}
								className="w-56 rounded-md border bg-transparent p-2 font-mono"
							/>
						</label>
						<div className="flex flex-col gap-1">
							<span className="text-muted-foreground">Default (blank: the CLI's own)</span>
							<Input
								aria-label={`${r.name} default model`}
								list={`${r.name}-models`}
								value={m.defaultModel ?? ''}
								onChange={(e) => set({ defaultModel: e.target.value || undefined })}
								className="h-8 w-48 font-mono"
							/>
						</div>
						<datalist id={`${r.name}-models`}>
							{tidy(m.models)?.map((x) => (
								<option key={x} value={x} />
							))}
						</datalist>
					</div>
				</Section>

				<Section title="Tool access">
					{r.allowlist ? (
						<label className="flex flex-col gap-1 text-xs">
							<span className="text-muted-foreground">
								Default allowlist, one per line (empty: all tools)
							</span>
							<textarea
								aria-label={`${r.name} tools`}
								rows={2}
								placeholder={'Read\nBash(git *)'}
								value={lines(m.tools)}
								onChange={(e) => set({ tools: split(e.target.value) })}
								className="max-w-md rounded-md border bg-transparent p-2 font-mono"
							/>
						</label>
					) : (
						<p className="text-xs text-muted-foreground">
							{r.name} cannot enforce a tool allowlist: its agents may use every tool.
						</p>
					)}
					<label className="flex flex-col gap-1 text-xs">
						<span className="text-muted-foreground">Network / filesystem notes</span>
						<textarea
							aria-label={`${r.name} notes`}
							rows={2}
							maxLength={1000}
							value={m.notes ?? ''}
							onChange={(e) => set({ notes: e.target.value || undefined })}
							className="max-w-md rounded-md border bg-transparent p-2"
						/>
					</label>
				</Section>

				<Section title="Accounts">
					{accounts.map((a, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until named
						<div key={i} className="flex flex-wrap items-center gap-2 text-xs">
							<Input
								aria-label={`${r.name} account ${i + 1} name`}
								placeholder="name"
								maxLength={40}
								value={a.name}
								onChange={(e) => setAccount(i, { name: e.target.value })}
								className="h-8 w-40"
							/>
							<Select
								aria-label={`${r.name} account ${i + 1} credential`}
								value={a.credential}
								onChange={(e) => setAccount(i, { credential: e.target.value })}
								className="h-8 font-mono"
							>
								<option value="">credential…</option>
								{[...new Set([...present, a.credential].filter(Boolean))].map((c) => (
									<option key={c} value={c}>
										{c}
										{present.includes(c) ? '' : ' (missing)'}
									</option>
								))}
							</Select>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => set({ accounts: accounts.filter((_, j) => j !== i) })}
							>
								Remove
							</Button>
						</div>
					))}
					<Button
						variant="outline"
						size="sm"
						className="self-start"
						onClick={() => set({ accounts: [...accounts, { name: '', credential: '' }] })}
					>
						Add account
					</Button>
				</Section>

				<Section title="MCP servers">
					{!r.mcp ? (
						<p className="text-xs text-muted-foreground">
							{r.name} does not take MCP servers from repo-ai yet.
						</p>
					) : (
						<>
							<p className="text-xs text-muted-foreground">
								Only the commands entered here ever run. Credentials are the api's{' '}
								<code>MCP_*</code> names
								{view.mcpCredentials.length ? `: ${view.mcpCredentials.join(', ')}` : ' (none set)'}
								. Tick the agents that may use each server.
							</p>
							{mcp.map((s, i) => (
								<McpRow
									// biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until named
									key={i}
									label={`${r.name} mcp ${i + 1}`}
									s={s}
									agentIds={[...new Set([...agentIds, ...s.agents])].sort()}
									mcpCredentials={view.mcpCredentials}
									set={(patch) => setMcp(i, patch)}
									remove={() => set({ mcp: mcp.filter((_, j) => j !== i) })}
								/>
							))}
							<Button
								variant="outline"
								size="sm"
								className="self-start"
								onClick={() => set({ mcp: [...mcp, { name: '', enabled: true, agents: [] }] })}
							>
								Add MCP server
							</Button>
						</>
					)}
				</Section>
			</CardContent>
		</Card>
	)
}

function McpRow({
	label,
	s,
	agentIds,
	mcpCredentials,
	set,
	remove,
}: {
	label: string
	s: Mcp
	agentIds: string[]
	mcpCredentials: string[]
	set: (patch: Partial<Mcp>) => void
	remove: () => void
}) {
	const remote = s.url !== undefined
	const missing = (tidy(s.env) ?? []).filter((e) => !mcpCredentials.includes(e))
	return (
		<div className="flex flex-col gap-2 rounded-md border p-3 text-xs">
			<div className="flex flex-wrap items-center gap-2">
				<Switch
					aria-label={`${label} enabled`}
					checked={s.enabled}
					onCheckedChange={(enabled) => set({ enabled })}
				/>
				<Input
					aria-label={`${label} name`}
					placeholder="name"
					maxLength={40}
					value={s.name}
					onChange={(e) => set({ name: e.target.value })}
					className="h-8 w-36 font-mono"
				/>
				<Select
					aria-label={`${label} transport`}
					value={remote ? 'url' : 'command'}
					onChange={(e) =>
						set(
							e.target.value === 'url'
								? { url: '', command: undefined, args: undefined }
								: { url: undefined, command: '' }
						)
					}
					className="h-8"
				>
					<option value="command">command</option>
					<option value="url">URL</option>
				</Select>
				{remote ? (
					<Input
						aria-label={`${label} URL`}
						placeholder="https://…"
						value={s.url ?? ''}
						onChange={(e) => set({ url: e.target.value })}
						className="h-8 w-72 font-mono"
					/>
				) : (
					<Input
						aria-label={`${label} command`}
						placeholder="npx"
						value={s.command ?? ''}
						onChange={(e) => set({ command: e.target.value })}
						className="h-8 w-48 font-mono"
					/>
				)}
				<Button variant="ghost" size="sm" onClick={remove}>
					Remove
				</Button>
			</div>
			<div className="flex flex-wrap gap-4">
				{!remote && (
					<label className="flex flex-col gap-1">
						<span className="text-muted-foreground">Args, one per line</span>
						<textarea
							aria-label={`${label} args`}
							rows={2}
							value={lines(s.args)}
							onChange={(e) => set({ args: split(e.target.value) })}
							className="w-56 rounded-md border bg-transparent p-2 font-mono"
						/>
					</label>
				)}
				<label className="flex flex-col gap-1">
					<span className="text-muted-foreground">Credentials (MCP_*), one per line</span>
					<textarea
						aria-label={`${label} credentials`}
						rows={2}
						value={lines(s.env)}
						onChange={(e) => set({ env: split(e.target.value) })}
						className="w-56 rounded-md border bg-transparent p-2 font-mono"
					/>
					{missing.length > 0 && (
						<span className="text-red-500">missing on the api: {missing.join(', ')}</span>
					)}
				</label>
			</div>
			<Row label="Agents">
				{agentIds.map((w) => (
					<label key={w} className="flex items-center gap-1.5 font-mono">
						<input
							type="checkbox"
							checked={s.agents.includes(w)}
							onChange={(e) =>
								set({
									agents: e.target.checked ? [...s.agents, w] : s.agents.filter((x) => x !== w),
								})
							}
						/>
						{w}
					</label>
				))}
				{agentIds.length === 0 && <span className="text-muted-foreground">no agents yet</span>}
			</Row>
		</div>
	)
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<h3 className="font-medium">{title}</h3>
			{children}
		</section>
	)
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
			<span className="text-muted-foreground">{label}</span>
			{children}
		</div>
	)
}
