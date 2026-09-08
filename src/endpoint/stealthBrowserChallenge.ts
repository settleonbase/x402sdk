export const STEALTH_BROWSER_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * Bot-challenge HTML detection. Intentionally does **not** match a bare
 * "cloudflare" string — real pages after a passed challenge still load CF scripts.
 */
export function isStealthChallengeHtml(html: string): boolean {
	return /just a moment|attention required|cf-browser-verification|challenge-platform|cdn-cgi\/challenge|checking your browser|enable javascript and cookies to continue|sorry, you have been blocked|cf-mitigated:\s*challenge/i.test(
		html,
	)
}
