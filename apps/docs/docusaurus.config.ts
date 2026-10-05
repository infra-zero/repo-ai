import type * as Preset from '@docusaurus/preset-classic'
import type { Config } from '@docusaurus/types'
import { copyright, GITHUB_PROFILE, projectFamilyItems } from '@rtorcato/shared-docs'
import { themes as prismThemes } from 'prism-react-renderer'

// The @rtorcato family, from the shared single source of truth — a navbar
// "Projects" dropdown and a footer column, as on every sibling site.
const PROJECT_FAMILY = projectFamilyItems()

const config: Config = {
	title: 'repo-ai',
	tagline:
		'Turns ai-ready GitHub issues into reviewed PRs — one worktree per issue, two agent reviewers.',
	favicon: 'img/favicon.svg',

	url: 'https://docs.torcato.dev',
	baseUrl: '/repo-ai/',

	organizationName: 'rtorcato',
	projectName: 'repo-ai',

	onBrokenLinks: 'warn',

	// Serves schemas/repo-ai.json at /repo-ai/repo-ai.json — the `$schema` URL
	// `fix config` writes into .repo-ai.json (#67).
	staticDirectories: ['static', '../../schemas'],

	markdown: {
		// mdx, not detect: ai-loop.md renders <LabelChips /> and can't be renamed
		// .mdx — loop-tick's SHARED_DOCS and setup.test.ts match it by name (#272).
		format: 'mdx',
		// ```mermaid fences render as diagrams — the ai-loop state machine (#272).
		mermaid: true,
		hooks: {
			onBrokenMarkdownLinks: 'warn',
		},
	},

	i18n: {
		defaultLocale: 'en',
		locales: ['en'],
	},

	presets: [
		[
			'classic',
			{
				docs: {
					sidebarPath: './sidebars.ts',
					routeBasePath: '/docs',
					editUrl: 'https://github.com/infra-zero/repo-ai/edit/main/apps/docs/',
				},
				blog: false,
				theme: {
					customCss: './src/css/custom.css',
				},
			} satisfies Preset.Options,
		],
	],

	themes: ['@docusaurus/theme-mermaid'],

	plugins: [
		[
			'@easyops-cn/docusaurus-search-local',
			{
				hashed: true,
				indexDocs: true,
				indexBlog: false,
				docsRouteBasePath: '/docs',
				highlightSearchTermsOnTargetPage: true,
				searchBarShortcutHint: false,
			},
		],
	],

	themeConfig: {
		image: 'img/social-card.png',
		colorMode: {
			defaultMode: 'dark',
			respectPrefersColorScheme: true,
		},
		navbar: {
			title: 'repo-ai',
			logo: { alt: 'repo-ai', src: 'img/favicon.svg' },
			items: [
				{ to: '/docs', position: 'left', label: 'Docs' },
				{ to: '/docs/ai-loop', position: 'left', label: 'Guide' },
				{ to: '/docs/commands', position: 'left', label: 'Commands' },
				{
					type: 'dropdown',
					label: 'Projects',
					position: 'left',
					items: [{ label: 'All on GitHub →', href: GITHUB_PROFILE }, ...PROJECT_FAMILY],
				},
				{ href: 'https://github.com/infra-zero/repo-ai', label: 'GitHub', position: 'right' },
				{
					href: 'https://www.npmjs.com/package/@infrazero/repo-ai',
					label: 'npm',
					position: 'right',
				},
			],
		},
		footer: {
			style: 'dark',
			links: [
				{
					title: 'Documentation',
					items: [
						{ label: 'Introduction', to: '/docs' },
						{ label: 'The AI Loop', to: '/docs/ai-loop' },
						{ label: 'Commands', to: '/docs/commands' },
						{ label: 'Changelog', to: '/docs/changelog' },
					],
				},
				{
					title: 'Resources',
					items: [
						{ label: 'GitHub', href: 'https://github.com/infra-zero/repo-ai' },
						{ label: 'npm', href: 'https://www.npmjs.com/package/@infrazero/repo-ai' },
						{ label: 'Issues', href: 'https://github.com/infra-zero/repo-ai/issues' },
						{ label: 'repo-tooling', href: 'https://docs.torcato.dev/repo-tooling/' },
					],
				},
				{ title: 'Projects', items: PROJECT_FAMILY },
				{
					title: 'Community',
					items: [
						{
							label: 'License (MIT)',
							href: 'https://github.com/infra-zero/repo-ai/blob/main/LICENSE',
						},
						{ label: '@rtorcato', href: GITHUB_PROFILE },
					],
				},
			],
			copyright: copyright(),
		},
		// `theme` is the LIGHT-mode Prism theme and `darkTheme` the dark one. Both
		// were vsDark here, which is why the shared stylesheet had to pin fenced
		// blocks dark in light mode too (#324). Keep this pairing and the CSS in
		// step — vsDark tokens on a light surface are unreadable.
		mermaid: { theme: { light: 'neutral', dark: 'dark' } },
		prism: {
			theme: prismThemes.vsLight,
			darkTheme: prismThemes.vsDark,
			additionalLanguages: ['bash', 'json', 'typescript'],
		},
	} satisfies Preset.ThemeConfig,
}

export default config
