import clsx from 'clsx'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
// The same table `doctor` and `fix labels` enforce, so these colours can't drift (#272).
import { LOOP_LABELS } from '../../../../../src/base/label-specs'
import { ACTORS, type NodeId, PASSES, SCENARIOS } from './scenarios'
import styles from './styles.module.css'

const COLOR = new Map(LOOP_LABELS.map((l) => [l.name, l.color]))

/** GitHub's rule of thumb: dark text on light fills, white on dark ones. */
function ink(hex: string): string {
	const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
	return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1f2328' : '#ffffff'
}

const MAP_WIDTH = 940

/** Where each state sits on the map; `label` colours it, and its absence means a plain step. */
const NODES: Record<NodeId, { x: number; y: number; text: string; sub?: string; label?: string }> =
	{
		ready: { x: 74, y: 60, text: 'ai-ready', label: 'ai-ready' },
		wip: { x: 224, y: 60, text: 'ai-wip', label: 'ai-wip' },
		review: { x: 374, y: 60, text: 'ai-review', label: 'ai-review' },
		reviewing: {
			x: 534,
			y: 60,
			text: 'ai-reviewing-*',
			sub: 'code and sec',
			label: 'ai-reviewing-code',
		},
		ok: { x: 700, y: 60, text: 'ai-ok-*', sub: 'code and sec', label: 'ai-ok-code' },
		mr: { x: 860, y: 60, text: 'merge-ready', label: 'merge-ready' },
		blocked: { x: 224, y: 190, text: 'ai-blocked', label: 'ai-blocked' },
		fixing: { x: 374, y: 190, text: 'ai-fixing', label: 'ai-fixing' },
		changes: { x: 534, y: 190, text: 'ai-changes', label: 'ai-changes' },
		merged: { x: 860, y: 190, text: 'You merge' },
		conflicts: { x: 700, y: 310, text: 'ai-conflicts', label: 'ai-conflicts' },
		done: { x: 860, y: 310, text: 'Cleaned up' },
	}

interface Edge {
	from: NodeId
	to: NodeId
	d: string
	text?: string
	at?: [number, number]
	dashed?: boolean
}

const EDGES: Edge[] = [
	{ from: 'ready', to: 'wip', d: 'M136 60H160', text: 'pickup', at: [148, 28] },
	{ from: 'wip', to: 'review', d: 'M286 60H310', text: 'PR opened', at: [298, 28] },
	{ from: 'review', to: 'reviewing', d: 'M436 60H470' },
	{ from: 'reviewing', to: 'ok', d: 'M596 60H636', text: 'both pass', at: [617, 28] },
	{ from: 'ok', to: 'mr', d: 'M762 60H796', text: 'green, clean', at: [779, 28] },
	{ from: 'mr', to: 'merged', d: 'M860 84V164' },
	{ from: 'merged', to: 'done', d: 'M860 214V284', text: 'later tick', at: [894, 252] },
	{ from: 'reviewing', to: 'changes', d: 'M534 84V164', text: 'defect', at: [512, 128] },
	{ from: 'ok', to: 'changes', d: 'M676 84L568 164', text: 'CI red', at: [640, 140] },
	{ from: 'ok', to: 'conflicts', d: 'M700 84V284', text: 'conflict', at: [728, 200] },
	{ from: 'changes', to: 'fixing', d: 'M470 190H438' },
	{
		from: 'conflicts',
		to: 'fixing',
		d: 'M636 310H374V216',
		text: 'merge main in, free',
		at: [505, 300],
	},
	{ from: 'fixing', to: 'review', d: 'M374 164V86', text: 'push', at: [392, 128] },
	{ from: 'fixing', to: 'blocked', d: 'M310 190H288', text: 'round 3', at: [299, 160] },
	{ from: 'wip', to: 'blocked', d: 'M224 84V164', text: 'stuck', at: [244, 128], dashed: true },
]

/** Prose with `backticked` spans rendered as inline code. */
function Prose({ text }: { text: string }): ReactNode {
	return text.split('`').map((part, i) =>
		// biome-ignore lint/suspicious/noArrayIndexKey: the split is static per step
		i % 2 ? <code key={i}>{part}</code> : part
	)
}

/** A label set, with what this step added ringed and what it removed struck through. */
function Chips({ now, before }: { now: string[]; before?: string[] }): ReactNode {
	const chip = (name: string, state?: string) => {
		const color = COLOR.get(name) ?? '888888'
		return (
			<span
				key={`${name}:${state ?? ''}`}
				className={clsx(styles.chip, state)}
				style={state === styles.gone ? undefined : { background: `#${color}`, color: ink(color) }}
			>
				{name}
			</span>
		)
	}
	const gone = before?.filter((l) => !now.includes(l)) ?? []
	if (now.length + gone.length === 0) return <span className={styles.none}>No loop labels</span>
	return (
		<>
			{now.map((l) => chip(l, before && !before.includes(l) ? styles.added : undefined))}
			{gone.map((l) => chip(l, styles.gone))}
		</>
	)
}

function Who({ login }: { login?: string }): ReactNode {
	return login ? <b>{login}</b> : 'nobody'
}

/** Step through issue #82 and PR #90 on the label state machine: `<LoopWalkthrough />`. */
export default function LoopWalkthrough(): ReactNode {
	const [scenario, setScenario] = useState(0)
	const [index, setIndex] = useState(0)
	const map = useRef<HTMLDivElement>(null)

	const { steps } = SCENARIOS[scenario]
	const step = steps[index]
	const before = index > 0 ? steps[index - 1] : undefined
	const node = NODES[step.node]

	const seen = new Set(steps.slice(0, index).map((s) => s.node))
	const walked = new Set(steps.slice(1, index + 1).map((s, i) => `${steps[i].node}>${s.node}`))

	// On a narrow screen the map scrolls sideways: keep the current state in view.
	useEffect(() => {
		const el = map.current
		if (!el || el.scrollWidth <= el.clientWidth) return
		const scale = el.scrollWidth / MAP_WIDTH
		el.scrollTo({ left: node.x * scale - el.clientWidth / 2, behavior: 'smooth' })
	}, [node.x])

	const go = (to: number) => setIndex(Math.max(0, Math.min(steps.length - 1, to)))
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'ArrowRight') go(index + 1)
		else if (e.key === 'ArrowLeft') go(index - 1)
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: arrow keys step while focus is inside; every action also has a button
		<div className={styles.root} onKeyDown={onKeyDown}>
			<div className={styles.tabs}>
				{SCENARIOS.map((s, i) => (
					<button
						key={s.name}
						type="button"
						className={styles.tab}
						aria-pressed={i === scenario}
						onClick={() => {
							setScenario(i)
							setIndex(0)
						}}
					>
						{s.name}
					</button>
				))}
			</div>

			<div className={styles.map} ref={map}>
				<svg viewBox={`0 0 ${MAP_WIDTH} 372`} role="img" aria-label="The ai-loop label state map">
					<defs>
						{[styles.tip, styles.tipOn].map((cls, i) => (
							<marker
								key={cls}
								id={i ? 'loop-walk-tip-on' : 'loop-walk-tip'}
								viewBox="0 0 10 10"
								refX="8"
								refY="5"
								markerWidth="7"
								markerHeight="7"
								orient="auto-start-reverse"
							>
								<path d="M0 0 10 5 0 10z" className={cls} />
							</marker>
						))}
					</defs>
					{EDGES.map((e) => {
						const on = walked.has(`${e.from}>${e.to}`)
						return (
							<g key={e.d}>
								<path
									d={e.d}
									className={clsx(styles.edge, e.dashed && styles.dashed, on && styles.edgeOn)}
									markerEnd={`url(#loop-walk-tip${on ? '-on' : ''})`}
								/>
								{e.text && e.at && (
									<text x={e.at[0]} y={e.at[1]} className={styles.edgeText}>
										{e.text}
									</text>
								)}
							</g>
						)
					})}
					{(Object.keys(NODES) as NodeId[]).map((id) => {
						const n = NODES[id]
						const fill = n.label ? COLOR.get(n.label) : undefined
						const text = fill ? ink(fill) : undefined
						return (
							<g
								key={id}
								transform={`translate(${n.x} ${n.y})`}
								className={clsx(
									styles.node,
									!fill && styles.plain,
									id === step.node ? styles.nodeOn : seen.has(id) && styles.nodeSeen
								)}
							>
								<rect x={-62} y={-22} width={124} height={44} rx={22} fill={fill && `#${fill}`} />
								<text y={n.sub ? -6 : 0} fill={text}>
									{n.text}
								</text>
								{n.sub && (
									<text y={10} fill={text} className={styles.sub}>
										{n.sub}
									</text>
								)}
							</g>
						)
					})}
					<rect
						className={styles.halo}
						x={-68}
						y={-28}
						width={136}
						height={56}
						rx={28}
						style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
					/>
				</svg>
			</div>

			<div className={styles.rows}>
				<div className={styles.row}>
					<div className={styles.rowTitle}>
						Issue #82 <span>Add --dry-run to fix labels</span>
					</div>
					<div className={styles.chips}>
						<Chips now={step.issue} before={before?.issue} />
					</div>
					<div className={styles.meta}>
						{step.issueClosed ? 'Closed' : 'Open'}, assigned to <Who login={step.issueAssignee} />.
						Worktree: <b>{step.worktree ? 'exists' : 'none'}</b>
					</div>
				</div>
				<div className={clsx(styles.row, !step.pr && styles.rowOff)}>
					<div className={styles.rowTitle}>
						PR #90 <span>feat(fix): add --dry-run to fix labels</span>
					</div>
					{step.pr ? (
						<>
							<div className={styles.chips}>
								<Chips now={step.pr} before={before?.pr} />
							</div>
							<div className={styles.meta}>
								{step.prMerged ? 'Merged' : 'Open'}, assigned to <Who login={step.prAssignee} />
							</div>
						</>
					) : (
						<div className={styles.meta}>Not opened yet</div>
					)}
				</div>
			</div>

			<div className={styles.story} aria-live="polite">
				<div className={styles.when}>
					{step.when}
					{step.pass !== undefined && `, pass ${step.pass}`}
				</div>
				<div className={styles.title}>{step.title}</div>
				<p>
					<Prose text={step.body} />
				</p>
				{step.cmd && <pre className={styles.cmd}>{step.cmd}</pre>}
				<div className={styles.controls}>
					<button
						type="button"
						className={styles.button}
						disabled={index === 0}
						onClick={() => go(index - 1)}
					>
						Back
					</button>
					<button
						type="button"
						className={clsx(styles.button, styles.primary)}
						disabled={index === steps.length - 1}
						onClick={() => go(index + 1)}
					>
						Next step
					</button>
					<span className={styles.count}>
						Step {index + 1} of {steps.length}
					</span>
					<div className={styles.dots}>
						{steps.map((s, i) => (
							<button
								// biome-ignore lint/suspicious/noArrayIndexKey: steps are a fixed sequence
								key={i}
								type="button"
								className={clsx(
									styles.dot,
									i < index && styles.dotPast,
									i === index && styles.dotNow
								)}
								aria-label={`Go to step ${i + 1}: ${s.title}`}
								title={s.title}
								onClick={() => go(i)}
							/>
						))}
					</div>
				</div>
			</div>

			<div className={styles.panels}>
				<div className={styles.panel}>
					<div className={styles.panelTitle}>Who is acting</div>
					<ul className={styles.list}>
						{ACTORS.map((a) => (
							<li key={a.id} className={clsx(a.id === step.actor && styles.on)}>
								<b>{a.name}</b>
								<span>{a.does}</span>
							</li>
						))}
					</ul>
				</div>
				<div className={styles.panel}>
					<div className={styles.panelTitle}>
						Passes in one tick{step.pass === undefined && ' (none running)'}
					</div>
					<ul className={styles.list}>
						{PASSES.map((name, i) => (
							<li key={name} className={clsx(i === step.pass && styles.on)}>
								<b>{i}</b>
								<span>{name}</span>
							</li>
						))}
					</ul>
				</div>
			</div>
		</div>
	)
}
