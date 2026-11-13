// 测试模式：唯一的覆盖入口。默认关闭；只有 BEAMIO_TEST_MODE=1 才生效。
// 生产保护：BEAMIO_TEST_MODE=1 且 NODE_ENV=production 时，模块加载即抛错，进程拒绝启动。
// 数据库覆盖只允许回环主机。本文件不得 import 其它模块。

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export const isTestMode = (): boolean => process.env.BEAMIO_TEST_MODE === '1'

if (isTestMode() && process.env.NODE_ENV === 'production') {
	throw new Error('refusing to start: BEAMIO_TEST_MODE=1 is not allowed when NODE_ENV=production')
}

/** 返回数据库连接串。测试模式下且设置 BEAMIO_TEST_DB_URL 时使用它（主机必须是回环地址）；否则返回 defaultUrl。 */
export const resolveDbUrl = (defaultUrl: string): string => {
	if (!isTestMode()) return defaultUrl
	const raw = process.env.BEAMIO_TEST_DB_URL?.trim()
	if (!raw) return defaultUrl
	let host: string
	try {
		host = new URL(raw).hostname
	} catch {
		throw new Error('BEAMIO_TEST_DB_URL is not a valid URL')
	}
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(`BEAMIO_TEST_DB_URL host must be loopback, got ${host}`)
	}
	return raw
}

/** 返回服务端口。测试模式下且环境变量为合法端口时覆盖；否则返回 fallback。 */
export const resolveTestPort = (envName: string, fallback: number): number => {
	const raw = process.env[envName]
	if (!isTestMode() || !raw) return fallback
	const n = Number(raw)
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
}
