# cl-payout-v2 运维说明：flush 作业看门狗、告警检查与无 txHash 挂起

本文件不在包内（`build.sh` 不复制它，清单不变）。原因：`STARTUP.txt` 随包冻结，不能为新增运维项改动它，所以另写本说明。
适用候选：`c7cddf4` 及之后（含 `529f727` 的挂起行为）。

## 0. 状态声明

- 告警检查脚本已写成可执行文件（`ops/alert-watch.sh`），并用真实测试日志和合成日志验证（见待审单）。
- **现场监控未接入**：本说明和脚本都不连接任何现场单元、通知渠道或主机。现场接入需要项目方批准，不属于本次交付。

## 1. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CONET_VALIDATOR_CL_FLUSH_JOB_WATCHDOG_MS` | `1200000`（20 分钟） | flush 签发作业的看门狗上限（毫秒）。数值小于 `60000`、非数字或未设置时回退默认值；大于 `86400000` 时按 `86400000` 截断。默认值 = 5 × 单批预算（flush 60 s + 签发 60 s + 回执 120 s）。正常作业只需几秒。 |
| `CONET_VALIDATOR_CL_INTENT_WAIT_ALERT_MS`（既有） | `1800000` | 挂起的在途意图超过该时长未拿到回执时，告警一次（不重发）。 |
| `CONET_RPC_HTTP_TIMEOUT_MS`、`CONET_VALIDATOR_CL_REWARD_PAYOUT_TX_WAIT_MS`（既有） | `60000`、`120000` | 决定单批的 60 s + 60 s + 120 s 预算，看门狗上限依此设定。 |

看门狗只告警和计数，不影响付款路径：不释放车道，不另起作业，不重签。

## 2. 日志文本与含义

看门狗日志（每个上限周期重复一次，每次计数）：

```
ALERT flush job unsettled for <N>s (cap <M>s; alert #<k>, total <t>). Signing lane stays busy: not released, not re-signed. Manual check required.
```

- 含义：一个签发作业超过上限仍未结束。签发车道保持忙，之后的 flush 步全部返回 `busy`，因此签发付款停止。扫描线不受影响。
- 作业结束后出现：`flush job settled after <N> (ALERTed <k> time(s) before settling)`，或超时分支的 `flush job settled after timeout; signing lane released`，表示车道已释放。

无 txHash 挂起的日志：`ACK-lost intent without txHash: hold (no resend; keys stay owned) idem=… status=…`。这一行只表示该键被挂起，不表示已恢复。

## 3. 告警检查脚本（可执行，未接入现场）

脚本：`ops/alert-watch.sh`，只读，不改账本、不签名、不重发。

```sh
# 现场接入时由运维填写单元名；脚本本身不含主机或单元名。
journalctl -u <claim-unit> -o cat | sh ops/alert-watch.sh -
# 离线检查日志文件：
sh ops/alert-watch.sh <日志文件>
```

退出码：`0` 表示没有未解除的看门狗告警（或告警之后已有 settled 行）；`1` 表示最后一条 `ALERT flush job unsettled` 之后没有 settled 行，即未解除；`2` 表示用法或输入错误。

- 可选：`NOTIFY_CMD=<命令>` 时，未解除告警的摘要作为最后一个参数传给该命令。通知方式由运维决定，本脚本不规定。
- 脚本对挂起的无 txHash 键只输出 `INFO ... (manual check, not auto-resolved)`，不判定是否解除。
- 已用真实测试日志验证：`dev2-suite.log` 判定为已解除（exit 0）；合成的未解除日志判定为未解除（exit 1）；先解除后又出现新告警的日志判定为未解除（exit 1）。

建议接入规则：`exit 1` 触发持续告警；告警解除以后续 settled 行为准。现场接入前需项目方批准。

## 4. 无 txHash 挂起的人工核查（不是自动恢复）

适用：intent 为 `prepared` 或 `uncertain`，没有 txHash，链上键未消耗。

daemon 在这种情况下的全部动作：读取原意图和链上消耗状态；**链上已消耗则记入结算（自动，不发送）；否则挂起（不发送，键留在 intent 名下，超时后告警一次）。** daemon 不会在挂起状态下自动重发、自动重建、自动删除 intent。

责任人（角色固定，姓名由项目方指定）：

| 角色 | 职责 | 姓名 |
|---|---|---|
| 挂起核查负责人（Claim 运维值班） | 执行第 1–2、5、6 步，记录结论，不执行任何写操作 | 待项目方指定 |
| 签字机侧证据负责人（签字机负责人） | 执行第 3 步的只读查询，提供签字机侧证据 | 待项目方指定 |
| 批准人（项目方） | 决定是否进入第 4 步的人工操作，书面批准 | 待项目方指定 |

人工核查步骤（只读，结果写入回执）：

1. 记录 intent 标识（idempotencyKey 前 24 个字符足够定位）、`eventKeys`、状态与 note、首次出现时间。只读取快照，不改任何文件。
2. 链上核对：对每个 `eventKey` 查询 `consumedRewardEventKey`。用两个 RPC 交叉核对。
   - 全部为 true：应已由 daemon 自动记入结算，核对是否已记入，然后结束。
   - 部分为 true，或任一读取失败：不处理，升级给项目方。
3. 签字机侧查询（只读，属于签字机的查询接口，不是 Claim 的去重）：查询该 idempotencyKey 是否有记录。
   - 有记录并给出 hash：记录该 hash，等待其回执。是否据此改写 intent，需项目方批准。
   - 无记录：仍然不能确定，继续挂起，升级。
   - 查询失败：挂起，升级。
4. 只有同时满足以下三项，才能进入项目方批准的人工操作（具体操作不在本说明内）：链上 `consumedRewardEventKey` 仍为 false；签字机侧证据证明该 idempotencyKey 从未签名，或其签名已确认失效且不会被广播；项目方书面批准。
5. 在第 4 条满足之前，禁止：删除 intent；改写 pending；以原 idempotencyKey 重发；以新 key 重签。
6. 每次核查结果都写入回执，包括没有处理的结论。

已知残余风险（未修，待项目方裁定）：`prepared` 且 pending 已不再覆盖时，daemon 走丢弃分支（不发送）。如果原请求已被签字机签名并广播，链上仍可能核销这些键，daemon 不会计入结算额（只会少计，不会双付）。

## 5. 与冻结版 88cdc832 的关系

冻结版对带 txHash、无回执的在途 intent 仍会盲重发同一 key。M5 回退的门槛不变：只能在无在途 intent（prepared、broadcast、uncertain 为 0）时回退。
