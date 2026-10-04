import type * as React from 'react'

export const ago = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000))
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	return h < 48 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.floor(h / 24)}d`
}

export const ageOf = (minutes: number) => ago(minutes * 60_000)
export const short = (repo: string) => repo.split('/')[1] ?? repo
export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false })
export const usd = (n: number) => `$${n.toFixed(2)}`

/** Titles and URLs come from GitHub: only https://github.com links become anchors. */
export function SafeLink({ href, children }: { href: string; children: React.ReactNode }) {
	if (!/^https:\/\/github\.com\//.test(href)) return <>{children}</>
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="font-mono text-primary hover:underline"
		>
			{children}
		</a>
	)
}
