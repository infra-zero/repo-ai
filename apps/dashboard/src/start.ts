import { createMiddleware, createStart } from '@tanstack/react-start'

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

/** Refuses any Host that is not loopback, so DNS rebinding cannot reach the config mutation. */
const loopbackOnly = createMiddleware().server(({ request, next }) => {
	if (!LOOPBACK.test(request.headers.get('host') ?? ''))
		return new Response('forbidden host', { status: 403 })
	return next()
})

export const startInstance = createStart(() => ({ requestMiddleware: [loopbackOnly] }))
