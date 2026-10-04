import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { type DaemonConfig, type DashboardView, saveConfig } from '~/lib/api'
import { STATE_KEY } from '~/lib/use-dashboard'
import { Button } from './ui/button'

/**
 * A draft of the api's config for one page. Polling refreshes the draft only
 * while the user has not touched it; each page saves the whole config.
 */
export function useConfigForm(
	view: DashboardView,
	clean: (d: DaemonConfig) => DaemonConfig = (d) => d
) {
	const qc = useQueryClient()
	const [draft, setDraft] = useState<DaemonConfig>(view.config)
	const [dirty, setDirty] = useState(false)
	useEffect(() => {
		if (!dirty) setDraft(view.config)
	}, [view.config, dirty])
	const save = useMutation({
		// Merge onto the live config so a page only overwrites what it edits.
		mutationFn: (d: DaemonConfig) => saveConfig({ data: clean(d) }),
		onSuccess: (v) => {
			setDirty(false)
			setDraft(v.config)
			qc.setQueryData(STATE_KEY, v)
		},
	})
	return {
		draft,
		dirty,
		save,
		edit: (f: (d: DaemonConfig) => DaemonConfig) => {
			setDraft(f)
			setDirty(true)
		},
		discard: () => {
			setDraft(view.config)
			setDirty(false)
		},
	}
}

type Form = ReturnType<typeof useConfigForm>

export function SaveBar({ form }: { form: Form }) {
	const { dirty, save, draft, discard } = form
	return (
		<div className="flex flex-wrap items-center gap-3">
			<Button disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
				{save.isPending ? 'Saving…' : 'Save'}
			</Button>
			{dirty && (
				<Button variant="ghost" onClick={discard}>
					Discard
				</Button>
			)}
			<span role="status" className="text-sm">
				{save.isError && <span className="text-red-500">{save.error.message}</span>}
				{save.isSuccess && !dirty && <span className="text-emerald-500">Saved.</span>}
			</span>
		</div>
	)
}
