import type { ReactNode } from 'react'
// The same table `doctor` and `fix labels` enforce, so these swatches can't drift (#272).
import { LOOP_LABELS } from '../../../../../src/base/label-specs'
import styles from './styles.module.css'

const BY_NAME = new Map(LOOP_LABELS.map((l) => [l.name, l]))

// Labels that live on issues; everything else is on PRs.
const ISSUE_LABELS = new Set(['ai-ready', 'ai-wip', 'ai-blocked', 'holding', 'ai-suggested'])

/** GitHub's rule of thumb: dark text on light fills, white on dark ones. */
function ink(hex: string): string {
	const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
	return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1f2328' : '#ffffff'
}

/** One label as GitHub renders it: `<Label name="ai-ready" />`. */
export function Label({ name }: { name: string }): ReactNode {
	const spec = BY_NAME.get(name)
	if (!spec) return <code>{name}</code>
	return (
		<span
			className={styles.chip}
			style={{ background: `#${spec.color}`, color: ink(spec.color) }}
			title={spec.description}
		>
			{spec.name}
		</span>
	)
}

/** A row of chips for a label combination: `<Labels names="ai-review ai-ok-code" />`. */
export function Labels({ names }: { names: string }): ReactNode {
	return (
		<span className={styles.row}>
			{names.split(/\s+/).map((n) => (
				<Label key={n} name={n} />
			))}
		</span>
	)
}

function Group({ title, issue }: { title: string; issue: boolean }): ReactNode {
	return (
		<div className={styles.group}>
			<div className={styles.groupTitle}>{title}</div>
			<ul className={styles.list}>
				{LOOP_LABELS.filter((l) => ISSUE_LABELS.has(l.name) === issue).map((l) => (
					<li key={l.name} className={styles.item}>
						<Label name={l.name} />
						<span className={styles.desc}>{l.description}</span>
						<code className={styles.hex}>#{l.color}</code>
					</li>
				))}
			</ul>
		</div>
	)
}

/** Every ai-loop label, grouped by where it lives. */
export default function LabelChips(): ReactNode {
	return (
		<div className={styles.grid}>
			<Group title="On issues" issue />
			<Group title="On pull requests" issue={false} />
		</div>
	)
}
