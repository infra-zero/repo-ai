import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { type DashboardView, saveConfig } from '~/lib/api'
import { STATE_KEY } from '~/lib/use-dashboard'
import { SaveBar, useConfigForm } from './config-form'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

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

/** Minimal list; the per-repo settings page is #305. */
export function Repos({ view }: { view: DashboardView }) {
	const form = useConfigForm(view)
	const { draft, edit } = form
	return (
		<div className="flex max-w-4xl flex-col gap-4">
			<Card>
				<CardHeader>
					<CardTitle>Repos</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-3">
					<div className="overflow-x-auto">
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
												onClick={() =>
													edit((d) => ({ ...d, repos: d.repos.filter((x) => x.repo !== r.repo) }))
												}
											>
												<Trash2 className="size-4" />
											</Button>
										</TableCell>
									</TableRow>
								))}
								{draft.repos.length === 0 && (
									<TableRow>
										<TableCell colSpan={4} className="text-muted-foreground">
											No repos yet.
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>
					{/* Saved on its own: a pending edit above is kept in the draft. */}
					{!form.dirty && <AddRepo view={view} />}
					{form.dirty && (
						<p className="text-xs text-muted-foreground">Save your changes to add another repo.</p>
					)}
				</CardContent>
			</Card>
			<SaveBar form={form} />
		</div>
	)
}
