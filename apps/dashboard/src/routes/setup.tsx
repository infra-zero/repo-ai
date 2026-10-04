import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { WithView } from '~/components/page'
import { Setup } from '~/components/setup'
import { STATE_KEY } from '~/lib/use-dashboard'

export const Route = createFileRoute('/setup')({ component: SetupPage })

function SetupPage() {
	const qc = useQueryClient()
	return (
		<WithView>
			{(view) => <Setup view={view} onSaved={(v) => qc.setQueryData(STATE_KEY, v)} />}
		</WithView>
	)
}
