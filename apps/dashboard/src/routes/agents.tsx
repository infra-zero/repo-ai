import { createFileRoute } from '@tanstack/react-router'
import { Agents } from '~/components/agents'
import { WithView } from '~/components/page'

export const Route = createFileRoute('/agents')({
	component: () => <WithView>{(view) => <Agents view={view} />}</WithView>,
})
