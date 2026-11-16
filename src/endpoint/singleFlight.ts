/**
 * 同一键的并发调用共享一次进行中的计算（single-flight）。计算完成（成功或失败）后移除该键，
 * 之后的调用重新计算。与 latestCards 的 inflight 去重同一模式。
 */
export type SingleFlight<V> = {
	run(key: string, fn: () => Promise<V>): Promise<V>
	/** 当前进行中的键数量（测试与诊断用）。 */
	inFlightCount(): number
}

export function createSingleFlight<V>(): SingleFlight<V> {
	const inflight = new Map<string, Promise<V>>()
	return {
		run(key, fn) {
			const existing = inflight.get(key)
			if (existing) return existing
			const task: Promise<V> = Promise.resolve()
				.then(fn)
				.finally(() => {
					if (inflight.get(key) === task) inflight.delete(key)
				})
			inflight.set(key, task)
			return task
		},
		inFlightCount() {
			return inflight.size
		},
	}
}
