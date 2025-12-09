import cluster from 'cluster'

export const logger = (...argv: any[]) => {
  const date = new Date()

  // 格式化时间
  const ts = `${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}:${date.getMilliseconds()}`

  // cluster 信息
  const wid = cluster.isPrimary
    ? 'master'
    : `worker-${cluster.worker?.id ?? 'unknown'}`

  // 彩色 prefix
  const prefix = `%c[${wid} INFO ${ts}]`

  return console.log(prefix, 'color: #6f4de7ff', ...argv)
}
