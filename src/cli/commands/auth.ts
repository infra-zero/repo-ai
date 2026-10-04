import chalk from 'chalk'
import { appCredentialsFromEnv, mintInstallationToken } from '../../base/app-auth.js'

/**
 * `repo-ai auth app-token --repo o/r` (#280): an installation token for the
 * loop's GitHub App, so `GH_TOKEN=$(repo-ai auth app-token --repo o/r)` puts
 * gh and git on the App's identity. Plain mode prints the token alone.
 */
export async function appTokenCommand(options: { repo: string; json?: boolean }): Promise<void> {
	const creds = await appCredentialsFromEnv()
	if (!creds) {
		console.error(
			chalk.red(
				'error: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_FILE (or GITHUB_APP_PRIVATE_KEY)'
			)
		)
		process.exitCode = 1
		return
	}
	try {
		const t = await mintInstallationToken(creds, options.repo)
		console.log(options.json ? JSON.stringify(t, null, 2) : t.token)
	} catch (err) {
		console.error(chalk.red(`error: ${(err as Error).message}`))
		process.exitCode = 1
	}
}
