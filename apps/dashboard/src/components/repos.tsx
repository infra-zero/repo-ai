import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, Settings2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { type DaemonConfig, type DashboardView, saveConfig } from '~/lib/api'
import { STATE_KEY } from '~/lib/use-dashboard'
import { ago } from './common'
import { SaveBar, useConfigForm } from './config-form'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Input } from './ui/input'
import { Switch } from './ui/switch'

const REPO = /^[A-Za-z0-9-]+\/[\w.-]+$/

/** Adds a repo and saves at once: the one-field form of the Repos page and the wizard. */
export function AddRepo({ view, onAdded }: { view: DashboardView; onAdded?: () => void }) {
	const qc = useQueryClient()
	const [repo, setRepo] = useState('')
	const [err, setErr] = useState('')
	const add = useMutation({
		mutationFn: (r: string) =>
			saveConfig({
				data: {
					...view.config,
					repos: [...view.config.repos, { repo: r, enabled: true, dependabotAutoReview: false }],
				},
			}),
		onSuccess: (v) => {
			qc.setQueryData(STATE_KEY, v)
			setRepo('')
			onAdded?.()
		},
	})
	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(e) => {
				e.preventDefault()
				const r = repo.trim()
				if (!REPO.test(r)) return setErr('Use the form owner/repo.')
				if (view.config.repos.some((x) => x.repo === r)) return setErr(`${r} is already added.`)
				setErr('')
				add.mutate(r)
			}}
		>
			<div className="flex gap-2">
				<Input
					aria-label="repo"
					placeholder="owner/repo"
					value={repo}
					onChange={(e) => setRepo(e.target.value)}
					className="max-w-xs font-mono"
				/>
				<Button type="submit" variant="outline" disabled={add.isPending}>
					<Plus className="size-4" />
					Add
				</Button>
			</div>
			<p role="status" className="text-xs text-red-500">
				{err || (add.isError ? add.error.message : '')}
			</p>
		</form>
	)
}

type Repo = DaemonConfig['repos'][number]
type Limit = keyof NonNullable<Repo['limits']>

/** Board stages with an agent or a fix round on them. */
const IN_FLIGHT = new Set(['wip', 'review', 'fixing', 'changes', 'conflicts'])

/** The repos as cards, and an "Add repo" card. Settings are per repo, one page each. */
export function Repos({ view }: { view: DashboardView }) {
	return (
		<div className="grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{view.repos.map((r) => {
				const [owner, name] = r.repo.split('/')
				const inFlight = r.state?.board.filter((b) => IN_FLIGHT.has(b.stage)).length ?? 0
				const tasks = view.tasks.filter(
					(t) => t.repo === r.repo && (t.state === 'queued' || t.state === 'running')
				).length
				return (
					<Card key={r.repo} className={r.enabled ? undefined : 'opacity-70'}>
						<CardHeader className="flex flex-row items-start justify-between gap-2">
							<CardTitle className="min-w-0 truncate font-mono text-sm">{r.repo}</CardTitle>
							<Button variant="ghost" size="icon" asChild>
								<Link
									to="/repos/$owner/$name"
									params={{ owner, name }}
									aria-label={`${r.repo} settings`}
								>
									<Settings2 className="size-4" />
								</Link>
							</Button>
						</CardHeader>
						<CardContent className="flex flex-wrap gap-1.5 text-xs">
							<Badge variant={r.enabled ? 'success' : 'muted'}>
								{r.enabled ? 'enabled' : 'disabled'}
							</Badge>
							<Badge variant="muted">
								{r.state ? `ticked ${ago(view.now - r.state.lastTick)} ago` : 'not ticked yet'}
							</Badge>
							<Badge variant={inFlight ? 'info' : 'muted'}>{inFlight} in flight</Badge>
							{tasks > 0 && <Badge variant="info">{tasks} tasks</Badge>}
							{r.state?.releaseGated && <Badge variant="warning">release-gated</Badge>}
							{r.state?.halt && (
								<Badge variant="danger" title={r.state.halt}>
									halted
								</Badge>
							)}
						</CardContent>
					</Card>
				)
			})}
			<Card>
				<CardHeader>
					<CardTitle className="text-sm">Add repo</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-2 text-xs text-muted-foreground">
					<p>The GitHub App must be installed on it. It is cloned on its first tick.</p>
					<AddRepo view={view} />
				</CardContent>
			</Card>
		</div>
	)
}

const LIMITS: { key: Limit; label: string; min: number; fallback: string }[] = [
	{ key: 'maxInFlight', label: 'Max issues in flight', min: 1, fallback: '6' },
	{ key: 'maxFixRounds', label: 'Max fix rounds per PR', min: 0, fallback: '2' },
	{ key: 'tokenBudget', label: 'Daily output-token budget', min: 0, fallback: 'none' },
]

const num = (v: string) => (v === '' ? undefined : Number(v))

/** One repo's settings. Agent profiles are edited on the Agents page; here only their scope. */
export function RepoSettings({ view, repo }: { view: DashboardView; repo: string }) {
	const form = useConfigForm(view)
	const { draft, edit } = form
	const qc = useQueryClient()
	const navigate = useNavigate()
	const remove = useMutation({
		mutationFn: () =>
			saveConfig({
				data: { ...view.config, repos: view.config.repos.filter((x) => x.repo !== repo) },
			}),
		onSuccess: (v) => {
			qc.setQueryData(STATE_KEY, v)
			void navigate({ to: '/repos' })
		},
	})
	const r = draft.repos.find((x) => x.repo === repo)
	if (!r)
		return (
			<p className="text-sm text-muted-foreground">
				{repo} is not configured. <Link to="/repos">Back to Repos</Link>
			</p>
		)
	const set = (patch: (x: Repo) => Repo) =>
		edit((d) => ({ ...d, repos: d.repos.map((x) => (x.repo === repo ? patch(x) : x)) }))
	const setLimit = (key: Limit, v: number | undefined) =>
		set((x) => {
			const limits = { ...x.limits, [key]: v }
			if (v === undefined) delete limits[key]
			return { ...x, limits }
		})

	const workerIds = [
		...new Set([...view.workers.map((w) => w.id), ...Object.keys(draft.workers)]),
	].sort()
	const others = draft.repos.map((x) => x.repo).filter((x) => x !== repo)
	return (
		<div className="flex max-w-2xl flex-col gap-4">
			<Card>
				<CardHeader>
					<CardTitle className="font-mono">{repo}</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4 text-sm">
					<div className="flex items-center justify-between gap-4">
						<label htmlFor="enabled" className="font-medium">
							Enabled
						</label>
						<Switch
							id="enabled"
							checked={r.enabled}
							onCheckedChange={(enabled) => set((x) => ({ ...x, enabled }))}
						/>
					</div>
					<div className="flex items-center justify-between gap-4">
						<label htmlFor="dependabot">
							<span className="font-medium">Dependabot → review</span>
							<span className="block text-xs text-muted-foreground">
								Label new Dependabot PRs ai-review so the loop reviews them.
							</span>
						</label>
						<Switch
							id="dependabot"
							checked={r.dependabotAutoReview}
							onCheckedChange={(dependabotAutoReview) =>
								set((x) => ({ ...x, dependabotAutoReview }))
							}
						/>
					</div>
					<div className="flex flex-col gap-1">
						<label htmlFor="pollSeconds" className="font-medium">
							Polling interval (seconds)
						</label>
						<Input
							id="pollSeconds"
							type="number"
							min={60}
							placeholder={String(draft.pollSeconds)}
							value={r.pollSeconds ?? ''}
							onChange={(e) => set((x) => ({ ...x, pollSeconds: num(e.target.value) }))}
							className="w-40"
						/>
						<span className="text-xs text-muted-foreground">
							Blank: the global default from Settings. Minimum 60.
						</span>
					</div>
					{LIMITS.map((f) => (
						<div key={f.key} className="flex flex-col gap-1">
							<label htmlFor={f.key} className="font-medium">
								{f.label}
							</label>
							<Input
								id={f.key}
								type="number"
								min={f.min}
								placeholder={String(draft[f.key] ?? f.fallback)}
								value={r.limits?.[f.key] ?? ''}
								onChange={(e) => setLimit(f.key, num(e.target.value))}
								className="w-40"
							/>
						</div>
					))}
					<span className="text-xs text-muted-foreground">
						Blank limits use the global default, else the repo’s own .repo-ai.json.
					</span>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Agents serving it</CardTitle>
					<p className="text-xs text-muted-foreground">
						An agent with no repos assigned serves every repo. Profiles are edited on the{' '}
						<Link to="/agents" className="underline">
							Agents
						</Link>{' '}
						page.
					</p>
				</CardHeader>
				<CardContent className="flex flex-col gap-2 text-sm">
					{workerIds.length === 0 && <p className="text-muted-foreground">No agents yet.</p>}
					{workerIds.map((id) => {
						const w = draft.workers[id] ?? { role: 'any' as const, repos: [] }
						const serves = w.repos.length === 0 || w.repos.includes(repo)
						// Unassigning: an empty list would mean every repo, so the last one cannot go here.
						const without = w.repos.length === 0 ? others : w.repos.filter((x) => x !== repo)
						return (
							<label key={id} className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={serves}
									disabled={serves && without.length === 0}
									onChange={(e) =>
										edit((d) => ({
											...d,
											workers: {
												...d.workers,
												[id]: { ...w, repos: e.target.checked ? [...w.repos, repo] : without },
											},
										}))
									}
								/>
								<span className="font-mono">{w.name ?? id}</span>
								<Badge variant="muted">{w.role}</Badge>
								{w.repos.length === 0 && <Badge variant="muted">all repos</Badge>}
							</label>
						)
					})}
				</CardContent>
			</Card>
			<SaveBar form={form} />
			<Card>
				<CardHeader>
					<CardTitle>Remove repo</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-2 text-sm">
					<p className="text-muted-foreground">
						The loop stops working it. Its clone stays on the volume.
					</p>
					<Button
						variant="outline"
						className="w-fit"
						disabled={remove.isPending}
						onClick={() => {
							if (window.confirm(`Remove ${repo}?`)) remove.mutate()
						}}
					>
						<Trash2 className="size-4" />
						Remove
					</Button>
					{remove.isError && <p className="text-xs text-red-500">{remove.error.message}</p>}
				</CardContent>
			</Card>
		</div>
	)
}
