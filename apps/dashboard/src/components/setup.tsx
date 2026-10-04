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

type Role = DaemonConfig['workers'][string]['role']
const ROLES: Role[] = ['any', 'implementer', 'reviewer', 'fixer']
const REPO = /^[A-Za-z0-9-]+\/[\w.-]+$/

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
		mutationFn: () => saveConfig({ data: draft }),
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
						A worker with no repos checked serves every repo.
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
								const w = draft.workers[id] ?? { role: 'any' as Role, repos: [] }
								return (
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
									</TableRow>
								)
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
