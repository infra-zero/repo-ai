import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import { type DaemonConfig, type DashboardView, saveConfig } from '~/lib/api'
import { STATE_KEY } from '~/lib/use-dashboard'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Select } from './ui/select'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from './ui/sheet'

export type Agent = DaemonConfig['agents'][number]
type Role = Agent['role']
const ROLES: Role[] = ['any', 'implementer', 'reviewer', 'fixer']

/** Worker ids that have connected but have no agent bound. */
export const freeSlots = (view: DashboardView) =>
	view.workers
		.map((w) => w.id)
		.filter((id) => !view.config.agents.some((a) => a.slot === id))
		.sort()

/** Saves the live config with `agents` replaced; the api validates and refuses a busy slot. */
function useSaveAgents(view: DashboardView, done: () => void) {
	const qc = useQueryClient()
	return useMutation({
		mutationFn: (agents: Agent[]) => saveConfig({ data: { ...view.config, agents } }),
		onSuccess: (v) => {
			qc.setQueryData(STATE_KEY, v)
			done()
		},
	})
}

const num = (v: string) => (v === '' ? undefined : Number(v))

/**
 * Add (`agent` undefined) or edit one agent (#307). The sheet keeps its own
 * draft; Save and Remove write the whole config at once.
 */
export function AgentSheet({
	view,
	agent,
	open,
	onOpenChange,
}: {
	view: DashboardView
	agent?: Agent
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const slots = [...(agent ? [agent.slot] : []), ...freeSlots(view)]
	const blank = (): Agent => ({
		id: `agent-${crypto.randomUUID().slice(0, 8)}`,
		slot: slots[0] ?? '',
		role: 'any',
		repos: [],
	})
	const [d, setD] = useState<Agent>(agent ?? blank)
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the sheet opens
	useEffect(() => {
		if (open) setD(agent ?? blank())
	}, [open])
	const set = (patch: Partial<Agent>) => setD((x) => ({ ...x, ...patch }))
	const save = useSaveAgents(view, () => onOpenChange(false))
	const others = view.config.agents.filter((a) => a.id !== agent?.id)
	const busy = !!agent && !!view.workers.find((w) => w.id === agent.slot)?.task
	const clean = (a: Agent): Agent => ({
		...a,
		tools: a.tools?.map((t) => t.trim()).filter(Boolean),
	})
	const names = [...new Set([...view.credentials, ...(d.credentials ?? [])])].sort()
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="overflow-y-auto sm:max-w-md">
				<SheetHeader>
					<SheetTitle>{agent ? `Edit ${agent.name || agent.id}` : 'Add agent'}</SheetTitle>
					<SheetDescription>
						An agent is a profile bound to one worker slot. Credentials are the api's model
						credentials by name; with none checked, the worker uses its own.
					</SheetDescription>
				</SheetHeader>
				<div className="flex flex-col gap-4 px-4 text-sm">
					<Field label="Slot">
						<Select value={d.slot} disabled={busy} onChange={(e) => set({ slot: e.target.value })}>
							{slots.map((s) => (
								<option key={s} value={s}>
									{s}
								</option>
							))}
						</Select>
					</Field>
					<div className="flex flex-wrap items-end gap-2">
						<Field label="Name">
							<Input
								value={d.name ?? ''}
								maxLength={40}
								onChange={(e) => set({ name: e.target.value })}
								className="w-40"
							/>
						</Field>
						<Field label="Avatar">
							<Input
								placeholder="🤖"
								value={d.avatar ?? ''}
								maxLength={8}
								onChange={(e) => set({ avatar: e.target.value })}
								className="w-16"
							/>
						</Field>
						<Field label="Color">
							<input
								type="color"
								value={d.color ?? '#888888'}
								onChange={(e) => set({ color: e.target.value })}
								className="h-9 w-10 cursor-pointer bg-transparent"
							/>
						</Field>
					</div>
					<div className="flex flex-wrap items-end gap-2">
						<Field label="Role">
							<Select value={d.role} onChange={(e) => set({ role: e.target.value as Role })}>
								{ROLES.map((r) => (
									<option key={r} value={r}>
										{r}
									</option>
								))}
							</Select>
						</Field>
						<Field label="Runner">
							<Select value={d.runner ?? 'claude'} onChange={() => set({ runner: 'claude' })}>
								<option value="claude">Claude Code</option>
							</Select>
						</Field>
						<Field label="Model">
							<Input
								placeholder="default"
								value={d.model ?? ''}
								onChange={(e) => set({ model: e.target.value })}
								className="w-36 font-mono"
							/>
						</Field>
					</div>
					<Field group label="Repos (none checked: every repo)">
						<div className="flex flex-wrap gap-x-4 gap-y-1">
							{view.config.repos.map((r) => (
								<label key={r.repo} className="flex items-center gap-1.5 text-xs">
									<input
										type="checkbox"
										checked={d.repos.includes(r.repo)}
										onChange={(e) =>
											set({
												repos: e.target.checked
													? [...d.repos, r.repo]
													: d.repos.filter((x) => x !== r.repo),
											})
										}
									/>
									{r.repo}
								</label>
							))}
						</div>
					</Field>
					<Field group label="Credentials">
						<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
							{names.map((c) => (
								<label key={c} className="flex items-center gap-1.5 font-mono">
									<input
										type="checkbox"
										checked={d.credentials?.includes(c) ?? false}
										onChange={(e) =>
											set({
												credentials: e.target.checked
													? [...(d.credentials ?? []), c]
													: (d.credentials ?? []).filter((x) => x !== c),
											})
										}
									/>
									{c}
									{!view.credentials.includes(c) && <span className="text-red-500">(missing)</span>}
								</label>
							))}
							{names.length === 0 && (
								<span className="text-muted-foreground">none on the api — the worker's own</span>
							)}
						</div>
					</Field>
					<Field label="Allowed tools, one per line (empty: all)">
						<textarea
							rows={3}
							placeholder={'Read\nBash(git *)'}
							value={(d.tools ?? []).join('\n')}
							onChange={(e) => set({ tools: e.target.value.split('\n') })}
							className="rounded-md border bg-transparent p-2 font-mono text-xs"
						/>
					</Field>
					<div className="flex flex-wrap items-end gap-2">
						<Field label="Poll when idle (s)">
							<Input
								type="number"
								min={1}
								max={600}
								placeholder="5"
								value={d.pollSeconds ?? ''}
								onChange={(e) => set({ pollSeconds: num(e.target.value) })}
								className="w-24"
							/>
						</Field>
						<Field label="Tokens / day">
							<Input
								type="number"
								min={0}
								placeholder="none"
								value={d.tokenBudget ?? ''}
								onChange={(e) => set({ tokenBudget: num(e.target.value) })}
								className="w-28"
							/>
						</Field>
						<Field label="$ / day">
							<Input
								type="number"
								min={0}
								step="0.01"
								placeholder="none"
								value={d.costBudgetUsd ?? ''}
								onChange={(e) => set({ costBudgetUsd: num(e.target.value) })}
								className="w-24"
							/>
						</Field>
					</div>
				</div>
				<SheetFooter>
					<span role="status" className="text-sm text-red-500">
						{save.isError && save.error.message}
					</span>
					<div className="flex flex-wrap gap-2">
						<Button
							disabled={!d.slot || save.isPending}
							onClick={() => save.mutate([...others, clean(d)])}
						>
							{save.isPending ? 'Saving…' : agent ? 'Save' : 'Add agent'}
						</Button>
						{agent && (
							<Button
								variant="destructive"
								disabled={busy || save.isPending}
								title={busy ? 'Its slot is running a task' : 'Unbind and free the slot'}
								onClick={() => save.mutate(others)}
							>
								Remove
							</Button>
						)}
					</div>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	)
}

function Field({
	label,
	group,
	children,
}: {
	label: string
	group?: boolean
	children: ReactNode
}) {
	// A checkbox list is a fieldset: a label may not wrap other labels.
	const Tag = group ? 'fieldset' : 'label'
	const Text = group ? 'legend' : 'span'
	return (
		<Tag className="flex flex-col gap-1">
			<Text className="mb-1 text-xs text-muted-foreground">{label}</Text>
			{children}
		</Tag>
	)
}
