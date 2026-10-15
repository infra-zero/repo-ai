# DESIGN.md

The design spec for the repo-ai docs site (`apps/docs`). Read it before changing the site's UI, and keep the UI in step with it. If the UI needs to change, update this file in the same PR.

- **Status:** v1, approved by rtorcato on 2026-10-15 in Buzz. UI PRs can build against it.
- **Designer:** Arcee (2026-10-15)
- **Mockups:** reviewed and signed off in Buzz (desktop and mobile, light and dark). They aren't kept in the repo.

## Principle

repo-ai's docs are one of the torcato.dev sites. They use the same Docusaurus v3 structure and shared theme as the rest, and change only the accent colour. Interactive pieces such as the loop walkthrough are part of the page, not embeds: they draw with the site's own `--jt-*` tokens and pink accent, never with Infima's neutral greys or a palette of their own.

## Loop walkthrough (`src/components/LoopWalkthrough/`)

The step-through demo of one issue becoming a PR. It lives on **/docs/ai-loop** under "Step through it" and nowhere else. The home page stays as it is (#420 first proposed moving it there, and rtorcato decided against it: too busy).

Layout and behaviour are unchanged. Only the colours change:

| Part | Style |
|---|---|
| Cards (map, Issue, PR, story, "Who is acting", "Passes in one tick") | `--jt-surface` fill, 1px `--jt-border`, radius 14px |
| Scenario tabs | Outline pills: `--jt-border2` border, `--jt-text`. The selected tab is a solid `--jt-accent` fill with `--jt-on-accent` text |
| State pills on the map | Neutral: `--jt-surface2` fill, 1px `--jt-border2`. The label's GitHub colour appears only as a 4.5px dot left of the text (text nudged 6px right) |
| Not visited yet | Label text `--jt-muted`, dot at 55% opacity. **No opacity on the text**, so it keeps AA contrast |
| Visited | Label text `--jt-heading`, full dot |
| Current state | `--jt-accent-soft` fill, `--jt-accent` stroke, `--jt-heading` text, plus the moving halo in `--jt-accent` |
| Plain steps ("You merge", "Cleaned up") | No fill, dashed `--jt-border2` stroke. Filled `--jt-accent-soft` when current |
| Edges | `--jt-faint`, 60% opacity. Edges taken so far are `--jt-accent` at 2.5px, arrowheads to match. Edge labels `--jt-muted` |
| Label chips (Issue and PR cards) | Keep their real GitHub colours from `LOOP_LABELS`, because those are what you see on GitHub. A newly added chip gets a `--jt-accent` ring |
| Back button | Outline: `--jt-border2` border, `--jt-heading` text |
| Next step button | Solid `--jt-accent`, `--jt-on-accent` text, weight 700 (same as Infima `.button--primary` in `theme.css`) |
| Progress dots | Upcoming `--jt-border2`, past `--jt-accent-border`, current `--jt-accent` |
| Active row in "Who is acting" / "Passes" | `--jt-accent-soft` background, 3px inset `--jt-accent` bar on the left, `--jt-heading` text. **Never pink text on the soft pink**: it measures 3.95:1 in light mode |

Implementation notes:

- Map the component's `--lw-*` variables onto `--jt-*` tokens in `.root`; don't hard-code hex values.
- `index.tsx` drops the per-label `fill` on the pill `<rect>` and adds the dot (`<circle cx={-48} r={4.5} fill={labelColour} />`). The colours still come from `LOOP_LABELS` in `src/base/label-specs.ts`, so they can't drift from `doctor` and `fix labels`.
- Progress shows through text colour and the accent path, not node opacity. Keep the `prefers-reduced-motion` block covering the pill and halo transitions.
- On phones the map keeps its 720px minimum width and scrolls sideways to the current state, as it does today.

## Tokens

The shared theme (`src/css/_jt-tokens.css` and `theme.css`, copied from repo-tooling) provides everything. The site sets only the accent in `src/css/custom.css`:

| Token | Light | Dark |
|---|---|---|
| `--ifm-color-primary`, `--jt-accent` | `#db2777` | `#f472b6` |
| `--jt-accent-soft` | `rgba(219, 39, 119, 0.1)` | `rgba(244, 114, 182, 0.14)` |
| `--jt-accent-border` | `rgba(219, 39, 119, 0.4)` | `rgba(244, 114, 182, 0.34)` |
| `--jt-on-accent` (text on accent) | `#ffffff` | `#0a0e16` |

Measured contrast (WCAG 2.1):

| Pair | Light | Dark |
|---|---|---|
| Text on accent (tab, Next step) | 4.60:1 | 7.29:1 |
| Unvisited pill label (`--jt-muted` on `--jt-surface2`) | 5.37:1 | 7.11:1 |
| Edge labels (`--jt-muted` on `--jt-surface`) | 5.83:1 | 6.79:1 |
| Active row text (`--jt-heading` on accent-soft) | 16.6:1 | 14.5:1 |
| Edge lines (`--jt-faint`, non-text, needs 3:1) | 3.03:1 | 3.59:1 |
| Accent text on accent-soft (**don't use**) | 3.95:1 | 5.46:1 |

## Type

Geist for everything and Geist Mono for code, as shipped by the shared theme. The walkthrough keeps its current sizes: tabs 14px/500 (600 when selected), pill labels 13px/600, pill sub-labels 10.5px/500, edge labels 11px/500, card titles 15px/600, story title 20px/700.

## Rules

- Override only the accent. Any other token change goes in the shared theme (repo-tooling / shared-docs), not here.
- Components draw with `--jt-*` tokens. Don't use `--ifm-color-emphasis-*` greys or ad-hoc palettes for surfaces, borders or text.
- GitHub label colours appear only where they stand for a real GitHub label (chips, the map dots).
- Accessibility: WCAG 2.1 AA contrast in both themes, a visible focus ring on every button and tab, and keyboard stepping (←/→) kept working in the walkthrough.

## Brand

The repo's own assets live in `brand/`, made with `npx @rtorcato/brand-kit` and rendered by `brand/render.sh`. The torcato.dev repos mark and favicon came from #417.

| Asset | File | Size |
|---|---|---|
| README banner | `brand/banner.png` (`banner.svg`) | 1280×320 |
| Mobile banner | `brand/banner-mobile.png` (`banner-mobile.svg`) | 1280×786 |
| Social card | `brand/social-card.png` (`social-card.svg`) | 1280×640 |
| Favicon | `brand/favicon.svg`, `favicon-512.png`, `favicon.ico` | SVG, 512, 16+32 |
