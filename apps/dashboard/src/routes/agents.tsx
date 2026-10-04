import { createFileRoute } from '@tanstack/react-router'
import { Agents } from '~/components/agents'
import { WorkerProfiles } from '~/components/worker-profiles'
import { WithView } from '~/components/page'

export const Route = createFileRoute('/agents')({
	component: () => (
		<WithView>
			{(view) => (
				<div className="flex flex-col gap-4">
					<Agents view={view} />
					<WorkerProfiles view={view} />
				</div>
			)}
		</WithView>
	),
})
