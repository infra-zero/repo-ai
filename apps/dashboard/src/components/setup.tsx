import { useMutation } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type DaemonConfig, type DashboardView, saveConfig } from '~/lib/api'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Input } from './ui/input'
import { Select } from './ui/select'
import { Switch } from './ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

type Worker = DaemonConfig['workers'][string]
type Role = Worker['role']
const ROLES: Role[] = ['any', 'implementer', 'reviewer', 'fixer']
const REPO = /^[A-Za-z0-9-]+\/[\w.-]+$/

/** The tools box keeps blank lines while typing; they go on save. */
const clean = (d: DaemonConfig): DaemonConfig => ({
	...d,
	workers: Object.fromEntries(
		Object.entries(d.workers).map(([id, w]) => [
			id,
			{ ...w, tools: w.tools?.map((t) => t.trim()).filter(Boolean) },
		])
	),
})

export function Setup({
	view,
	onSaved,
}: {
	view: DashboardView
	onSaved: (v: DashboardView) => void
}) {
	const [draft, setDraft] = useState<DaemonConfig>(view.config)
	const [dirty, setDirty] = useState(false)
	const [newRepo, setNewRepo] = useState('')

	// Polling refreshes the form only while the user has not touched it.
	useEffect(() => {
		if (!dirty) setDraft(view.config)
	}, [view.config, dirty])

	const edit = (f: (d: DaemonConfig) => DaemonConfig) => {
		setDraft(f)
		setDirty(true)
	}
	const save = useMutation({
		mutationFn: () => saveConfig({ data: clean(draft) }),
		onSuccess: (v) => {
			setDirty(false)
			setDraft(v.config)
			onSaved(v)
		},
	})

	const workerIds = [
		...new Set([...view.workers.map((w) => w.id), ...Object.keys(draft.workers)]),
	].sort()
	const setWorker = (id: string, patch: Partial<DaemonConfig['workers'][string]>) =>
		edit((d) => ({
			...d,
			workers: {
				...d.workers,
				[id]: { ...(d.workers[id] ?? { role: 'any', repos: [] }), ...patch },
			},
		}))
	const addRepo = () => {
		const repo = newRepo.trim()
		if (!REPO.test(repo) || draft.repos.some((r) => r.repo === repo)) return
		edit((d) => ({
			...d,
			repos: [...d.repos, { repo, enabled: true, dependabotAutoReview: false }],
		}))
		setNewRepo('')
	}
	const removeRepo = (repo: string) =>
		edit((d) => ({
			repos: d.repos.filter((r) => r.repo !== repo),
			pollSeconds: d.pollSeconds,
			workers: Object.fromEntries(
				Object.entries(d.workers).map(([id, w]) => [
					id,
					{ ...w, repos: w.repos.filter((x) => x !== repo) },
				])
			),
		}))

	return (
		<div className="flex max-w-4xl flex-col gap-4">
			<Card>
				<CardHeader>
					<CardTitle>Repos</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-2">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Repo</TableHead>
								<TableHead>Enabled</TableHead>
								<TableHead>Dependabot → review</TableHead>
								<TableHead />
							</TableRow>
						</TableHeader>
						<TableBody>
							{draft.repos.map((r, i) => (
								<TableRow key={r.repo}>
									<TableCell className="font-mono">{r.repo}</TableCell>
									<TableCell>
										<Switch
											aria-label={`${r.repo} enabled`}
											checked={r.enabled}
											onCheckedChange={(enabled) =>
												edit((d) => ({
													...d,
													repos: d.repos.map((x, j) => (j === i ? { ...x, enabled } : x)),
												}))
											}
										/>
									</TableCell>
									<TableCell>
										<Switch
											aria-label={`${r.repo} dependabot auto-review`}
											checked={r.dependabotAutoReview}
											onCheckedChange={(dependabotAutoReview) =>
												edit((d) => ({
													...d,
													repos: d.repos.map((x, j) =>
														j === i ? { ...x, dependabotAutoReview } : x
													),
												}))
											}
										/>
									</TableCell>
									<TableCell className="text-right">
										<Button
											variant="ghost"
											size="icon"
											aria-label={`remove ${r.repo}`}
											onClick={() => removeRepo(r.repo)}
										>
											<Trash2 className="size-4" />
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
					<form
						className="flex gap-2"
						onSubmit={(e) => {
							e.preventDefault()
							addRepo()
						}}
					>
						<Input
							placeholder="owner/repo"
							value={newRepo}
							onChange={(e) => setNewRepo(e.target.value)}
							className="max-w-xs font-mono"
						/>
						<Button type="submit" variant="outline">
							<Plus className="size-4" />
							Add
						</Button>
					</form>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Polling</CardTitle>
				</CardHeader>
				<CardContent className="flex items-center gap-2 text-sm">
					Tick every
					<Input
						type="number"
						min={60}
						value={draft.pollSeconds}
						onChange={(e) => edit((d) => ({ ...d, pollSeconds: Number(e.target.value) }))}
						className="w-24"
					/>
					seconds (minimum 60)
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Workers</CardTitle>
					<p className="text-xs text-muted-foreground">
						A worker with no repos checked serves every repo. Credentials are the api's model
						credentials by name — values stay in <code>docker/.env</code>. With none checked, the
						worker uses its own. With tools listed, the agent may use only those.
					</p>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Worker</TableHead>
								<TableHead>Role</TableHead>
								<TableHead>Repos</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{workerIds.map((id) => {
								const w: Worker = draft.workers[id] ?? { role: 'any', repos: [] }
								return [
									<TableRow key={id}>
										<TableCell className="font-mono">{id}</TableCell>
										<TableCell>
											<Select
												aria-label={`${id} role`}
												value={w.role}
												onChange={(e) => setWorker(id, { role: e.target.value as Role })}
											>
												{ROLES.map((r) => (
													<option key={r} value={r}>
														{r}
													</option>
												))}
											</Select>
										</TableCell>
										<TableCell>
											<div className="flex flex-wrap gap-x-4 gap-y-1">
												{draft.repos.map((r) => (
													<label key={r.repo} className="flex items-center gap-1.5 text-xs">
														<input
															type="checkbox"
															checked={w.repos.includes(r.repo)}
															onChange={(e) =>
																setWorker(id, {
																	repos: e.target.checked
																		? [...w.repos, r.repo]
																		: w.repos.filter((x) => x !== r.repo),
																})
															}
														/>
														{r.repo}
													</label>
												))}
											</div>
										</TableCell>
									</TableRow>,
									<TableRow key={`${id}-profile`}>
										<TableCell colSpan={3}>
											<Profile
												id={id}
												w={w}
												credentials={view.credentials}
												set={(patch) => setWorker(id, patch)}
											/>
										</TableCell>
									</TableRow>,
								]
							})}
							{workerIds.length === 0 && (
								<TableRow>
									<TableCell colSpan={3} className="text-muted-foreground">
										No workers have connected yet.
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</CardContent>
			</Card>

			<div className="flex items-center gap-3">
				<Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
					{save.isPending ? 'Saving…' : 'Save'}
				</Button>
				{dirty && (
					<Button
						variant="ghost"
						onClick={() => {
							setDraft(view.config)
							setDirty(false)
						}}
					>
						Discard
					</Button>
				)}
				{save.isError && <span className="text-sm text-red-500">{save.error.message}</span>}
				{save.isSuccess && !dirty && <span className="text-sm text-emerald-500">Saved.</span>}
			</div>
		</div>
	)
}

function Profile({
	id,
	w,
	credentials,
	set,
}: {
	id: string
	w: Worker
	credentials: string[]
	set: (patch: Partial<Worker>) => void
}) {
	// Named on the profile but missing from the api: shown, so it can be unchecked.
	const names = [...new Set([...credentials, ...(w.credentials ?? [])])].sort()
	return (
		<div className="flex flex-col gap-2 pb-2 text-xs">
			<div className="flex flex-wrap items-center gap-2">
				<Input
					aria-label={`${id} name`}
					placeholder="name"
					value={w.name ?? ''}
					maxLength={40}
					onChange={(e) => set({ name: e.target.value })}
					className="h-8 w-32"
				/>
				<Input
					aria-label={`${id} avatar`}
					placeholder="🤖"
					value={w.avatar ?? ''}
					maxLength={8}
					onChange={(e) => set({ avatar: e.target.value })}
					className="h-8 w-16"
				/>
				<input
					type="color"
					aria-label={`${id} color`}
					value={w.color ?? '#888888'}
					onChange={(e) => set({ color: e.target.value })}
					className="h-8 w-10 cursor-pointer bg-transparent"
				/>
				<Select
					aria-label={`${id} runner`}
					value={w.runner ?? 'claude'}
					onChange={() => set({ runner: 'claude' })}
				>
					<option value="claude">Claude Code</option>
				</Select>
				<Input
					aria-label={`${id} model`}
					placeholder="model (default)"
					value={w.model ?? ''}
					onChange={(e) => set({ model: e.target.value })}
					className="h-8 w-40 font-mono"
				/>
			</div>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				<span className="text-muted-foreground">Credentials</span>
				{names.map((c) => (
					<label key={c} className="flex items-center gap-1.5 font-mono">
						<input
							type="checkbox"
							checked={w.credentials?.includes(c) ?? false}
							onChange={(e) =>
								set({
									credentials: e.target.checked
										? [...(w.credentials ?? []), c]
										: (w.credentials ?? []).filter((x) => x !== c),
								})
							}
						/>
						{c}
						{!credentials.includes(c) && <span className="text-red-500">(missing)</span>}
					</label>
				))}
				{names.length === 0 && (
					<span className="text-muted-foreground">none on the api — the worker's own</span>
				)}
			</div>
			<label className="flex flex-col gap-1">
				<span className="text-muted-foreground">Allowed tools, one per line (empty: all)</span>
				<textarea
					aria-label={`${id} tools`}
					rows={2}
					placeholder={'Read\nBash(git *)'}
					value={(w.tools ?? []).join('\n')}
					onChange={(e) => set({ tools: e.target.value.split('\n') })}
					className="max-w-md rounded-md border bg-transparent p-2 font-mono"
				/>
			</label>
		</div>
	)
}
