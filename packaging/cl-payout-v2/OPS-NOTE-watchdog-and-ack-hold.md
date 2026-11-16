# cl-payout-v2 运维说明：flush 作业看门狗与 ACK 丢失挂起

本文件不在包内（`build.sh` 不复制它，清单不变）。原因：`STARTUP.txt` 随包冻结，不能为新增运维项改动它，所以另写本说明。
适用候选：`c7cddf4` 及之后（含 `529f727` 的挂起行为）。

## 1. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CONET_VALIDATOR_CL_FLUSH_JOB_WATCHDOG_MS` | `1200000`（20 分钟） | flush 签发作业的看门狗上限（毫秒）。数值小于 `60000`、非数字或未设置时回退默认值；大于 `86400000` 时按 `86400000` 截断。默认值 = 5 × 单批预算（flush 60 s + 签发 60 s + 回执 120 s）。正常作业只需几秒。 |
| `CONET_VALIDATOR_CL_INTENT_WAIT_ALERT_MS`（既有） | `1800000` | 挂起的在途意图超过该时长未拿到回执时，告警一次（不重发）。 |
| `CONET_RPC_HTTP_TIMEOUT_MS`、`CONET_VALIDATOR_CL_REWARD_PAYOUT_TX_WAIT_MS`（既有） | `60000`、`120000` | 决定单批的 60 s + 60 s + 120 s 预算，看门狗上限依此设定。 |

看门狗只告警和计数，不影响付款路径：不释放车道，不另起作业，不重签。

## 2. ALERT 含义与处理

看门狗日志（每个上限周期重复一次，每次计数）：

```
ALERT flush job unsettled for <N>s (cap <M>s; alert #<k>, total <t>). Signing lane stays busy: not released, not re-signed. Manual check required.
```

- 含义：一个签发作业超过上限仍未结束。签发车道保持忙，之后的 flush 步全部返回 `busy`，因此签发付款停止。扫描线不受影响。
- 作业结束后出现：`flush job settled after <N> (ALERTed <k> time(s) before settling)`，表示车道已释放。
- 处理顺序：先确认签字机是否仍在处理该请求，以及 RPC 是否挂起；不要在未核对前重启后直接重签；不要删除在途意图或改 pending；按第 4 节核对。

## 3. 日志监控样例（占位符，未部署）

以下样例只说明规则，单元名和通知命令由运维替换。不包含主机、路径或账户信息。

```sh
#!/bin/sh
# 样例，未部署。UNIT 与 NOTIFY 为占位符。
UNIT="<claim-unit>"
NOTIFY="<notify-command>"
# 1) 签发作业挂起：每次出现都通知（同一上限周期内会重复出现）。
journalctl -u "$UNIT" --since "-10min" -o cat | grep -F 'ALERT flush job unsettled' | tail -n 1 | "$NOTIFY" "claim flush lane busy"
# 2) 挂起的在途意图（无 txHash）：超过等待上限后告警一次。
journalctl -u "$UNIT" --since "-10min" -o cat | grep -F 'ALERT intent still without receipt' | tail -n 1 | "$NOTIFY" "claim intent without receipt"
# 3) 无 txHash 的 ACK 丢失挂起：每个 flush 步都会记录，出现即表示有键被挂起。
journalctl -u "$UNIT" --since "-10min" -o cat | grep -F 'ACK-lost intent without txHash: hold' | tail -n 1 | "$NOTIFY" "claim keys held (no txHash)"
# 4) 解除：看到 settled 行说明车道已释放，应撤销第 1 条告警。
journalctl -u "$UNIT" --since "-10min" -o cat | grep -F 'flush job settled after' | tail -n 1 | "$NOTIFY" "claim flush lane released"
```

建议：告警系统对第 1 条做“持续未解除”判断（最后一条 ALERT 之后没有 settled 行）。日志行含 ANSI 颜色码时，`grep -F` 仍可匹配，因为颜色码包住了整行。

## 4. ACK 丢失后的恢复（intent 没有 txHash）

适用情形：intent 为 `prepared`（进程在收到签字机回复前中断），或 `uncertain`（回执丢失，错误信息含 `timed out`、`ECONNRESET`、`socket`、`ACK` 或 `no transaction hash`），且没有 txHash。

daemon 的核对顺序（`recoverOpenIntents`）：

1. 读取该 intent 的 `eventKeys`（与原始 `requestFingerprint`）。
2. 链上查询每个键的 `consumedRewardEventKey`：
   - 全部已消耗：记入结算，不发送（`credited`）。
   - 部分已消耗，或任一读取失败：UNKNOWN，挂起，不发送。
   - 全部未消耗：挂起，不发送。
3. 挂起期间：键留在该 intent 名下，不会被新 intent 再签；超过等待上限后告警一次。

何时重发（daemon 的规则，不以原 idempotencyKey 重发）：

- 不以原 idempotencyKey 重发，任何情况下都不做。
- 只有 intent 有 txHash、无回执，且 nonce 已被推进（`judgeTxReplacedOrDropped` 为 `replaced_or_dropped`），且键仍未消耗（`intentConsumedOnChain` 为 `open`），才会以新 key 重建（`.rN`）。无 txHash 的挂起单不会自动重建。

何时挂起：第 2 步中出现 UNKNOWN、部分消耗、或全部未消耗（无 txHash）时挂起。当前没有自动解除路径。

人工解除的前提（需项目方批准，本说明不规定操作细节）：链上 `consumedRewardEventKey` 仍为 false，且签字机侧审计能证明该 idempotencyKey 从未签名。满足前不得删除 intent、不得改 pending、不得重签。

## 5. 与冻结版 88cdc832 的关系

冻结版对带 txHash、无回执的在途 intent 仍会盲重发同一 key。M5 回退的门槛不变：只能在无在途 intent（prepared、broadcast、uncertain 为 0）时回退。
