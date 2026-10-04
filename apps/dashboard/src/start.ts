import { createMiddleware, createStart } from '@tanstack/react-start'

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

/**
 * Refuses a non-loopback Host (DNS rebinding) and any request another site
 * started (CSRF): a page elsewhere can still POST to 127.0.0.1 with a
 * loopback Host, but the browser marks it cross-site and names its Origin.
 */
const loopbackOnly = createMiddleware().server(({ request, next }) => {
	if (!LOOPBACK.test(request.headers.get('host') ?? ''))
		return new Response('forbidden host', { status: 403 })
	const site = request.headers.get('sec-fetch-site')
	if (site && site !== 'same-origin' && site !== 'none')
		return new Response('cross-site request refused', { status: 403 })
	const origin = request.headers.get('origin')
	if (origin && origin !== 'null' && !LOOPBACK.test(new URL(origin).host))
		return new Response('cross-origin request refused', { status: 403 })
	return next()
})

export const startInstance = createStart(() => ({ requestMiddleware: [loopbackOnly] }))
