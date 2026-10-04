import type { DashboardView } from '~/lib/api'
import { SaveBar, useConfigForm } from './config-form'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Input } from './ui/input'

type Num = 'pollSeconds' | 'maxInFlight' | 'maxFixRounds' | 'tokenBudget'

const FIELDS: { key: Num; label: string; hint: string; min: number; placeholder?: string }[] = [
	{
		key: 'pollSeconds',
		label: 'Polling interval (seconds)',
		hint: 'Default for every repo and worker; each can override it. Minimum 60.',
		min: 60,
	},
	{
		key: 'maxInFlight',
		label: 'Max issues in flight',
		hint: 'Default per repo. Blank: 6, or the repo’s own setting.',
		min: 1,
		placeholder: '6',
	},
	{
		key: 'maxFixRounds',
		label: 'Max fix rounds per PR',
		hint: 'Default per repo. Blank: 2, or the repo’s own setting.',
		min: 0,
		placeholder: '2',
	},
	{
		key: 'tokenBudget',
		label: 'Daily output-token budget',
		hint: 'Blank or 0: no budget.',
		min: 0,
		placeholder: 'none',
	},
]

/** Global defaults only; per-repo and per-agent overrides live on their own pages. */
export function Settings({ view }: { view: DashboardView }) {
	const form = useConfigForm(view)
	const { draft, edit } = form
	return (
		<div className="flex max-w-2xl flex-col gap-4">
			<Card>
				<CardHeader>
					<CardTitle>Global defaults</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{FIELDS.map((f) => (
						<div key={f.key} className="flex flex-col gap-1 text-sm">
							<label htmlFor={f.key} className="font-medium">
								{f.label}
							</label>
							<Input
								id={f.key}
								type="number"
								min={f.min}
								placeholder={f.placeholder}
								value={draft[f.key] ?? ''}
								onChange={(e) =>
									edit((d) => ({
										...d,
										[f.key]: e.target.value === '' ? undefined : Number(e.target.value),
									}))
								}
								className="w-40"
							/>
							<span className="text-xs text-muted-foreground">{f.hint}</span>
						</div>
					))}
				</CardContent>
			</Card>
			<SaveBar form={form} />
		</div>
	)
}
