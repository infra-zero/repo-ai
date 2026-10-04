import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getState } from './api'

export const STATE_KEY = ['state'] as const

/** One poll shared by the shell and every route through the query cache. */
export const useDashboard = () =>
	useQuery({
		queryKey: STATE_KEY,
		queryFn: () => getState(),
		refetchInterval: 5000,
		placeholderData: keepPreviousData,
	})
