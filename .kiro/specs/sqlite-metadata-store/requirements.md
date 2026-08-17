# Requirements Document

## Introduction

当前平台没有数据库：全部元数据以本地磁盘 JSON 文件保存（`data/users.json`、`data/invite-uses.json`、`data/sessions/*.json`，以及 `data/users/{userId}/` 下的 `generations/` `assets/` `credits/` `billing-holds/` `llm-usage/` `drama-projects/`），媒体二进制归档到阿里云 OSS。该实现在 100 注册用户以内可用，但会先在**记录条数**上出问题：列表接口对整个目录做全量读取与内存排序、启动恢复串行遍历全部生成记录、`withUserStoreLock` 是全局串行写锁、跨文件写入没有事务保证。

本特性把元数据迁移到 SQLite（Node 内置 `node:sqlite`，开启 WAL），媒体二进制继续放 OSS 不入库，部署保持单机单进程形态。迁移同时解决四件事：按用户加锁替代全局锁、列表接口改为带索引的分页查询、启动恢复只处理非终态与可恢复记录、积分余额与流水在单个事务内一起提交。

范围内包含一次性数据迁移工具，必须保证既有用户的余额、流水、冻结、生成记录、文件资产、短剧项目、邀请码核销记录不丢不错，并且现有 HTTP API 契约对 `public/app.js` 与 `public/drama-studio.js` 不产生破坏性变更。

不在本次范围内：引入 Postgres 或其他外部数据库；多进程/多实例部署；把 `activeGenerations` 与 `loginAttempts` 这两个进程内 Map 迁出内存；媒体文件入库；前端分页交互改造。

## Glossary

- **Metadata_Store**：基于 `node:sqlite` `DatabaseSync` 的元数据存储层，持有唯一的数据库文件与全部读写语句。
- **Schema_Manager**：负责建库、建表、建索引、写入并校验 schema 版本号的组件。
- **Migration_Tool**：把现有 `data/` 下 JSON 记录一次性导入 Metadata_Store 的命令行工具。
- **Migration_Report**：Migration_Tool 产出的结构化结果，含各集合源记录数、入库记录数、跳过记录数、钱包对账结果与整体结论。
- **Ledger**：积分账目服务，包含扣费、退款、冻结、结算、释放五类操作。
- **Ledger_Entry**：一条积分流水记录，含 `type`、`amountMicro`、`balanceAfterMicro` 与幂等键。
- **Billing_Hold**：LLM 调用的额度冻结记录，状态取值为 `held`、`settled`、`released`、`billing_reconcile_required`。
- **Wallet**：单个用户的积分状态，含 `creditBalanceMicro`（余额）与 `creditHeldMicro`（冻结）。
- **Lock_Manager**：按用户标识串行化写操作的组件，替代当前的全局 Promise 队列。
- **List_API**：`GET /api/generations`、`GET /api/files`、`GET /api/credits`、`GET /api/drama/projects`、`GET /api/drama/projects/latest` 这组列表接口。
- **Session_Store**：会话记录的存储与生命周期管理组件。
- **Recovery_Job**：进程启动后执行一次的生成任务恢复流程，替代 `recoverCompletedProviderResults`。
- **Terminal_Status**：生成任务的终态，指 `completed`，以及已完成退款或已确认无法恢复的 `failed`。
- **Non_Terminal_Status**：生成任务的非终态，指 `queued`、`running`，以及带有 `providerTaskId` 且尚未归档成品的 `failed`。
- **API_Server**：`server.mjs` 暴露的 HTTP 服务。
- **Legacy_Store**：迁移前的 JSON 文件存储实现。
- **Micro_Credit**：积分的最小记账单位，1 积分等于 1,000,000 Micro_Credit。

## Requirements

### Requirement 1: SQLite 存储基础设施

**User Story:** 作为平台维护者，我希望元数据保存在单个 SQLite 数据库文件中并具备明确的 schema 版本，以便在不引入外部服务和原生依赖的前提下获得索引查询与事务能力。

#### Acceptance Criteria

1. THE Metadata_Store SHALL 使用 Node 内置模块 `node:sqlite` 访问数据库，且 `package.json` 的 `dependencies` 中新增依赖数量为 0。
2. THE Metadata_Store SHALL 把数据库文件保存在 `DATA_DIR` 解析出的目录下的 `studio.db`，并在同一目录允许 SQLite 生成 `-wal` 与 `-shm` 附属文件。
3. WHEN Metadata_Store 打开数据库连接，THE Metadata_Store SHALL 依次设置 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`、`synchronous=NORMAL`。
4. THE Schema_Manager SHALL 创建并维护 9 张业务表：`users`、`sessions`、`invite_uses`、`credit_entries`、`billing_holds`、`llm_usage`、`generations`、`assets`、`drama_projects`。
5. THE Schema_Manager SHALL 在 `schema_meta` 表中保存当前 schema 版本号与应用时间。
6. WHEN Schema_Manager 读到的 schema 版本号高于当前代码支持的版本号，THE API_Server SHALL 拒绝启动并输出包含代码支持版本与数据库版本的错误信息。
7. THE Metadata_Store SHALL 把积分金额以 Micro_Credit 为单位存为 `INTEGER` 列，不使用浮点列。
8. THE Metadata_Store SHALL 为下列查询建立索引：`credit_entries(user_id, created_at DESC, id)`、`generations(user_id, created_at DESC, id)`、`generations(status)`、`assets(user_id, created_at DESC, id)`、`drama_projects(user_id, updated_at DESC, id)`、`billing_holds(user_id, status)`、`sessions(expires_at)`。
9. THE Metadata_Store SHALL 为 `generations`、`assets`、`drama_projects`、`credit_entries`、`billing_holds`、`llm_usage` 六张表建立指向 `users(id)` 的外键约束。
10. WHERE 运行环境的 Node 版本低于 22.5.0，THE API_Server SHALL 拒绝启动并输出所需的最低 Node 版本，且 `package.json` 的 `engines.node` SHALL 声明 `>=22.5.0`。
11. THE API_Server SHALL 在启动日志中输出数据库文件路径、schema 版本与 WAL 状态各 1 次。
12. WHERE 运行环境把 `node:sqlite` 标记为实验特性，THE API_Server SHALL 正常完成启动并在日志中说明该警告来源于 Node 内置模块。

### Requirement 2: 一次性数据迁移的完整性

**User Story:** 作为平台维护者，我希望用一条命令把现有 JSON 数据完整导入 SQLite，并拿到可核对的迁移报告，以便确认既有账号的余额、流水与作品没有丢失或错位。

#### Acceptance Criteria

1. THE Migration_Tool SHALL 通过 `npm run migrate` 独立执行，不依赖 API_Server 处于运行状态。
2. THE Migration_Tool SHALL 迁移下列 9 类记录：`data/users.json` 中的用户、`data/invite-uses.json` 中的邀请码核销、`data/sessions/` 下的会话、以及每个用户目录下的 `generations/`、`assets/`、`credits/`、`billing-holds/`、`llm-usage/`、`drama-projects/` 记录。
3. WHEN Migration_Tool 完成一次迁移，THE Migration_Report SHALL 对每一类记录给出源记录数、入库记录数与跳过记录数，且入库记录数与跳过记录数之和等于源记录数。
4. THE Migration_Tool SHALL 保留每条记录的原始标识符：用户 `id`、会话文件名对应的 token 哈希、生成任务 `id`、资产 `id`、流水文件名、冻结记录 `id`、LLM 用量 `id`、短剧项目 `id`。
5. THE Migration_Tool SHALL 把每条记录中当前 schema 未建列的字段原样保存到该表的 `extra_json` 列，使记录在读取时可还原为迁移前的对象结构。
6. WHEN Migration_Tool 处理完全部记录，THE Migration_Tool SHALL 对每个用户核对入库后的 `creditBalanceMicro` 等于该用户全部 Ledger_Entry 的 `amountMicro` 之和，并把核对结果写入 Migration_Report。
7. IF 任一用户的余额核对结果不一致，THEN THE Migration_Tool SHALL 回滚本次全部写入、以非 0 退出码结束，并在 Migration_Report 中列出不一致的用户标识与差额。
8. IF 某个 JSON 文件无法解析或缺少必填字段，THEN THE Migration_Tool SHALL 把该文件记入 Migration_Report 的跳过清单并继续处理其余文件。
9. THE Migration_Tool SHALL 把 Migration_Report 以 JSON 格式写入 `DATA_DIR` 下的 `migration-report-{时间戳}.json`。
10. THE Migration_Tool SHALL 保持 Legacy_Store 的 JSON 文件与本地媒体缓存文件的内容和路径不变。
11. WHEN Migration_Tool 迁移成功，THE Migration_Tool SHALL 在 `schema_meta` 中写入迁移完成标记，含完成时间与各类记录条数。
12. WHILE `DATA_DIR` 中存在 Legacy_Store 的用户 JSON 记录且 `schema_meta` 中没有迁移完成标记，THE API_Server SHALL 拒绝启动并输出执行 `npm run migrate` 的提示。

### Requirement 3: 迁移的幂等性与可重复执行

**User Story:** 作为平台维护者，我希望迁移命令可以安全地重复执行，以便在中断、失败或验证后重跑时不产生重复数据。

#### Acceptance Criteria

1. THE Migration_Tool SHALL 在单个数据库事务中提交一次迁移的全部写入。
2. IF 迁移过程中发生任何异常，THEN THE Migration_Tool SHALL 回滚该事务，使数据库回到本次迁移开始前的状态。
3. WHEN Migration_Tool 在已完成迁移的数据库上再次执行，THE Migration_Tool SHALL 使用记录标识符做冲突判定，使每条源记录在库中仅存在 1 行。
4. WHEN Migration_Tool 连续执行 2 次且期间 Legacy_Store 未发生变化，THE Metadata_Store SHALL 在两次执行后给出相同的各表记录数与相同的每用户余额。
5. WHERE 命令带有 `--dry-run` 参数，THE Migration_Tool SHALL 产出完整 Migration_Report 且不写入任何数据库行。
6. WHERE 命令带有 `--verify` 参数，THE Migration_Tool SHALL 逐条比对库中记录与 Legacy_Store 记录的字段值，并在 Migration_Report 中给出比对通过的记录数与不一致的记录清单。

### Requirement 4: 积分账目的事务原子性与守恒

**User Story:** 作为平台用户，我希望每次余额变动都伴随一条对应的流水记录，以便账目在任何失败或崩溃场景下都保持可核对。

#### Acceptance Criteria

1. THE Ledger SHALL 在同一个数据库事务内完成 Wallet 更新与 Ledger_Entry 写入。
2. IF Wallet 更新与 Ledger_Entry 写入中的任一步失败，THEN THE Ledger SHALL 回滚该事务，使 Wallet 与 Ledger_Entry 均不发生变化。
3. THE Ledger SHALL 使得任一用户的 `creditBalanceMicro` 等于该用户全部 Ledger_Entry 的 `amountMicro` 之和。
4. THE Ledger SHALL 使得任一用户的 `creditHeldMicro` 等于该用户状态为 `held` 的全部 Billing_Hold 的 `reservedMicro` 之和。
5. THE Ledger SHALL 使得任一用户的 `creditBalanceMicro` 与 `creditHeldMicro` 均为非负整数，且 `creditHeldMicro` 不大于 `creditBalanceMicro`。
6. WHEN 扣费请求的金额大于可用余额（余额减冻结），THE Ledger SHALL 拒绝该请求、返回 HTTP 402、并保持 Wallet 与 Ledger_Entry 不变。
7. THE Ledger SHALL 为每条 Ledger_Entry 使用幂等键，取值沿用现有命名 `charge-{generationId}`、`refund-{generationId}`、`hold-{requestId}`、`capture-{requestId}`、`release-{requestId}`、`signup-bonus`，并在数据库层对 `(user_id, idempotency_key)` 建立唯一约束。
8. WHEN 同一幂等键的记账操作被重复提交，THE Ledger SHALL 保持 Wallet 与该幂等键对应的 Ledger_Entry 与首次提交后完全一致，并返回首次提交的结果。
9. WHEN Billing_Hold 结算时实际费用不大于冻结额度，THE Ledger SHALL 在单个事务内扣减余额、释放该 Billing_Hold 的全部冻结额度、把 Billing_Hold 状态置为 `settled`、写入 `llm_usage` 记录并写入 `capture-{requestId}` 流水。
10. IF Billing_Hold 结算时实际费用大于冻结额度，THEN THE Ledger SHALL 把该 Billing_Hold 状态置为 `billing_reconcile_required`、保持余额与冻结额度不变、并写入含错误原因的 `llm_usage` 记录。
11. WHEN 调用未完成需要释放冻结，THE Ledger SHALL 在单个事务内减少 `creditHeldMicro`、把 Billing_Hold 状态置为 `released` 并写入 `release-{requestId}` 流水，且 `creditBalanceMicro` 保持不变。
12. THE Ledger SHALL 使得每条 Ledger_Entry 的 `balanceAfterMicro` 等于该用户按 `(created_at, id)` 排序后本条及之前全部 Ledger_Entry 的 `amountMicro` 之和。

### Requirement 5: 按用户加锁的并发安全

**User Story:** 作为平台用户，我希望自己的记账请求不被其他用户的请求阻塞，同时自己的并发请求不会造成余额错乱。

#### Acceptance Criteria

1. THE Lock_Manager SHALL 以用户标识为粒度串行化针对同一用户的写操作。
2. WHILE 某个用户的写操作正在进行，THE Lock_Manager SHALL 允许其他用户的写操作并行执行。
3. WHEN 同一用户的 N 个扣费请求并发到达且余额充足，THE Ledger SHALL 使最终余额等于初始余额减去 N 笔扣费之和，并写入 N 条流水。
4. WHEN 同一用户的 N 个扣费请求并发到达且余额只够 M 笔（M 小于 N），THE Ledger SHALL 让恰好 M 个请求成功、其余请求返回 HTTP 402，且最终余额为非负数。
5. WHEN 针对同一用户的写操作抛出异常，THE Lock_Manager SHALL 释放该用户的锁，使该用户的后续写操作可以继续执行。
6. THE Lock_Manager SHALL 在同一用户的锁被占用时让后续操作等待，而不是直接失败。
7. THE Ledger SHALL 使记账结果不依赖同一用户并发请求的到达顺序：任一到达顺序下的最终 `creditBalanceMicro` 与 Ledger_Entry 集合均相同。

### Requirement 6: 列表接口的分页与索引查询

**User Story:** 作为平台用户，我希望任务列表、文件库和积分流水在记录累积到数千条后仍然秒开，以便日常使用不受历史数据量影响。

#### Acceptance Criteria

1. THE List_API SHALL 通过带索引的 SQL 查询取数，不再枚举目录或读取单条 JSON 文件。
2. THE List_API SHALL 支持 `limit` 与 `cursor` 两个查询参数，`limit` 的取值范围为 1 到 200。
3. WHERE 请求未提供 `limit`，THE List_API SHALL 使用默认值 100。
4. IF `limit` 或 `cursor` 的取值非法，THEN THE List_API SHALL 返回 HTTP 400 并说明合法取值范围。
5. THE List_API SHALL 按 `created_at` 降序、`id` 升序作为稳定排序键返回记录，`GET /api/drama/projects` 按 `updated_at` 降序、`id` 升序返回记录。
6. WHILE 底层数据未发生写入，THE List_API SHALL 使得按 `cursor` 连续翻页取得的记录序列与一次性取全量记录的序列相同，且不出现重复或遗漏。
7. THE List_API SHALL 在响应头 `X-Total-Count` 中返回该用户在当前筛选条件下的记录总数，在 `X-Next-Cursor` 中返回下一页游标。
8. WHEN 当前页是最后一页，THE List_API SHALL 省略 `X-Next-Cursor` 响应头。
9. THE List_API SHALL 在数据库层完成 `GET /api/generations` 的 `type` 筛选与 `GET /api/files` 的 `kind` 筛选。
10. WHEN `GET /api/credits` 被调用，THE API_Server SHALL 仅查询该用户最近 20 条 Ledger_Entry，不读取其余流水记录。
11. WHEN 单个用户拥有 50,000 条 Ledger_Entry，THE API_Server SHALL 在 50 毫秒内完成 `GET /api/credits` 的数据库查询部分。
12. WHEN 单个用户拥有 20,000 条生成记录，THE API_Server SHALL 在 50 毫秒内完成 `GET /api/generations` 默认首页的数据库查询部分。
13. WHEN `GET /api/drama/projects/latest` 被调用，THE API_Server SHALL 使用 `LIMIT 1` 查询取回最近更新的项目，不读取其余项目记录。

### Requirement 7: 会话生命周期

**User Story:** 作为平台用户，我希望登录会话在数据库中被正确管理并及时清理过期记录，以便登录状态可靠且存储不无限增长。

#### Acceptance Criteria

1. THE Session_Store SHALL 以会话令牌的 SHA-256 哈希作为 `sessions` 表主键，且不保存令牌明文。
2. THE Session_Store SHALL 为每条会话保存 `user_id`、`expires_at`、`created_at`。
3. WHEN 请求携带的会话令牌哈希在 `sessions` 表中存在且 `expires_at` 晚于当前时间，THE API_Server SHALL 把该请求识别为对应用户的已登录请求。
4. IF 请求携带的会话令牌哈希不存在或对应记录已过期，THEN THE API_Server SHALL 返回 HTTP 401 并删除该过期记录。
5. WHEN 用户登出，THE Session_Store SHALL 删除对应会话记录并清除会话 Cookie。
6. WHEN API_Server 启动，THE Session_Store SHALL 通过 `expires_at` 索引删除全部已过期会话记录。
7. THE Session_Store SHALL 每隔 6 小时执行一次过期会话清理。
8. WHEN 用户被删除，THE Session_Store SHALL 通过外键级联删除该用户的全部会话记录。
9. THE API_Server SHALL 保持会话 Cookie 的名称 `studio_session`、`HttpOnly`、`SameSite=Lax`、`Path=/`、`Max-Age` 为 14 天，以及生产环境下的 `Secure` 属性不变。

### Requirement 8: 启动恢复只处理非终态任务

**User Story:** 作为平台维护者，我希望服务启动时只处理确实需要恢复的生成任务，以便启动时间不随历史记录总量增长，并且不遗留卡在中间状态的任务。

#### Acceptance Criteria

1. THE Recovery_Job SHALL 使用 `generations(status)` 索引查询待恢复记录，不遍历全部生成记录。
2. THE Recovery_Job SHALL 把待恢复集合定义为处于 Non_Terminal_Status 的生成记录，判定条件不依赖 `error` 字段的文本内容。
3. WHEN 待恢复记录带有 `providerTaskId` 与 `sourceUrl` 且没有 `assetId`，THE Recovery_Job SHALL 重新执行成品归档，成功后把状态置为 `completed`。
4. WHEN 待恢复记录处于 `queued` 或 `running` 且没有 `providerTaskId`，THE Recovery_Job SHALL 把状态置为 `failed`，并按 `refund-{generationId}` 幂等键执行退款。
5. WHEN 待恢复记录处于 `running` 且带有 `providerTaskId`，THE Recovery_Job SHALL 继续轮询该服务商任务直至成功、失败或超时。
6. IF 恢复某条记录时发生异常，THEN THE Recovery_Job SHALL 记录该条错误并继续处理剩余记录。
7. THE Recovery_Job SHALL 使得同一条生成记录在任意次数的恢复执行后，退款金额合计等于该记录 `creditCost` 的 0 倍或 1 倍。
8. THE API_Server SHALL 在 Recovery_Job 完成之前开始监听端口并接受请求。
9. WHEN Recovery_Job 结束，THE Recovery_Job SHALL 输出 1 条日志，含待恢复记录数、恢复成功数、退款数与失败数。
10. WHEN 数据库中存在 100,000 条生成记录且其中 0 条处于 Non_Terminal_Status，THE Recovery_Job SHALL 在 200 毫秒内结束。

### Requirement 9: HTTP API 契约向后兼容

**User Story:** 作为前端维护者，我希望后端换成 SQLite 后现有页面无需改动即可工作，以便本次改造不牵连前端发布。

#### Acceptance Criteria

1. THE API_Server SHALL 保持现有全部路由的路径、HTTP 方法与状态码语义不变。
2. THE API_Server SHALL 保持 `GET /api/generations` 与 `GET /api/files` 的响应体为 JSON 数组，数组元素字段与迁移前一致。
3. THE API_Server SHALL 保持 `GET /api/credits` 的响应体包含 `balance`、`held`、`available`、`balanceMicro`、`heldMicro`、`availableMicro`、`pricing`、`transactions` 字段，且 `transactions` 为最多 20 条流水的数组。
4. THE API_Server SHALL 保持 `GET /api/drama/projects` 的响应体为 `{ projects: [...] }`，`GET /api/drama/projects/latest` 与 `GET /api/drama/projects/{id}` 的响应体为 `{ project: {...} }`。
5. THE API_Server SHALL 保持短剧项目对象经 `normalizeDramaProject` 处理后的字段结构与取值规则不变，含 `schemaVersion`、`workflowVersion`、`settings`、`scenes`、`resources`、`shots`、`productionQuality`、`step`、`maxStep`。
6. THE API_Server SHALL 保持生成任务对象的 `id`、`type`、`status`、`prompt`、`referenceAssetIds`、`creditCost`、`creditStatus`、`assetId`、`providerTaskId`、`error`、`createdAt`、`updatedAt`、`finishedAt` 字段语义不变。
7. THE API_Server SHALL 保持文件资产对象附带 `url` 字段且取值为 `/api/files/{id}/content`。
8. THE API_Server SHALL 保持积分数值以积分为单位对外返回，小数精度与迁移前一致。
9. THE API_Server SHALL 保持媒体二进制文件继续保存在阿里云 OSS 与本地缓存目录，`assets` 表只保存元数据与 `ossKey`。
10. WHEN 现有测试套件 `npm test` 执行，THE API_Server SHALL 使全部既有测试通过。
11. THE API_Server SHALL 使 `public/app.js` 与 `public/drama-studio.js` 的源码保持不变即可完成登录、生成、列表、文件管理与短剧工作台全流程。

### Requirement 10: 数据隔离与访问控制

**User Story:** 作为平台用户，我希望改用共享数据库后仍然只能访问自己的数据，以便账号之间的隔离不被削弱。

#### Acceptance Criteria

1. THE Metadata_Store SHALL 在每条业务记录查询中以 `user_id` 作为必备筛选条件。
2. WHEN 用户请求不属于自己的生成记录、文件资产、短剧项目或流水记录，THE API_Server SHALL 返回 HTTP 404 且不返回该记录的任何字段。
3. THE API_Server SHALL 保持短剧分镜只能绑定当前用户自己的生成任务。
4. THE API_Server SHALL 保持注册时的邀请码唯一核销语义：`invite_uses` 表对邀请码建立唯一约束，重复使用的注册请求返回 HTTP 409。
5. THE API_Server SHALL 保持密码以带随机盐的 `scrypt` 哈希保存，不保存明文密码。

### Requirement 11: 运维与可回退

**User Story:** 作为平台维护者，我希望迁移后仍有明确的回退路径和数据备份手段，以便出现问题时可以快速恢复服务。

#### Acceptance Criteria

1. THE Migration_Tool SHALL 在写入前把已存在的数据库文件备份为 `studio.db.bak-{时间戳}`。
2. THE Metadata_Store SHALL 提供一条备份命令，产出可直接替换使用的数据库文件副本。
3. WHILE API_Server 正在运行，THE Metadata_Store SHALL 允许备份命令在不停止服务的情况下完成。
4. IF 数据库文件缺失或损坏导致无法打开，THEN THE API_Server SHALL 拒绝启动并输出数据库文件路径与失败原因。
5. THE Metadata_Store SHALL 提供一条一致性自检命令，输出每个用户的余额与流水之和的比对结果、冻结额度与 `held` 状态 Billing_Hold 之和的比对结果。
6. WHEN 一致性自检发现不一致，THE Metadata_Store SHALL 以非 0 退出码结束并列出涉及的用户标识与差额。
7. THE README SHALL 记录迁移命令、备份命令、自检命令与最低 Node 版本要求。

## 正确性属性

以下属性用于指导设计阶段的测试策略，标注了适用的测试形式。

### 守恒类属性（不变式）

- **P1 余额守恒**：对任意用户、任意记账操作序列，`creditBalanceMicro` 等于全部 Ledger_Entry 的 `amountMicro` 之和。对应 4.3。适合属性测试：随机生成扣费、退款、冻结、结算、释放的操作序列。
- **P2 冻结守恒**：对任意用户，`creditHeldMicro` 等于状态为 `held` 的 Billing_Hold 的 `reservedMicro` 之和。对应 4.4。适合属性测试。
- **P3 非负与上界**：对任意操作序列，`0 <= creditHeldMicro <= creditBalanceMicro`。对应 4.5。适合属性测试。
- **P4 流水快照一致**：每条 Ledger_Entry 的 `balanceAfterMicro` 等于其前缀和。对应 4.12。适合属性测试。
- **P5 原子性**：在事务中间点注入失败时，Wallet 与 Ledger_Entry 同时保持不变。对应 4.2。适合示例测试：对每类记账操作各注入 1 次失败。

### 幂等类属性

- **P6 记账幂等**：同一幂等键提交 N 次（N 大于等于 1）与提交 1 次的库状态相同。对应 4.8。适合属性测试。
- **P7 迁移幂等**：`migrate` 执行 N 次后各表记录数与每用户余额与执行 1 次相同。对应 3.3、3.4。适合属性测试：随机生成 Legacy_Store 数据集后重复迁移。
- **P8 退款幂等**：任意条数的 Recovery_Job 重复执行后，单条生成记录的退款次数不超过 1。对应 8.7。适合属性测试。

### 往返类属性

- **P9 记录往返**：Legacy_Store 的 JSON 记录经迁移入库再读出，得到的对象与源对象在业务字段上等价（未建列字段经 `extra_json` 还原）。对应 2.5、3.6。适合属性测试：随机生成含未知字段的记录。
- **P10 短剧项目规范化往返**：短剧项目对象经 `normalizeDramaProject` 处理后写库再读出再规范化，结果保持不变（规范化的幂等性）。对应 9.5。适合属性测试。

### 分页类属性

- **P11 分页拼接等价**：在无写入的前提下，按任意合法 `limit` 连续翻页拼接得到的记录序列，等于一次性全量查询的序列。对应 6.6。适合属性测试：随机 `limit` 与随机记录集。
- **P12 分页无重复**：任意翻页序列中每条记录出现且仅出现 1 次。对应 6.6。适合属性测试。
- **P13 排序稳定**：存在相同 `created_at` 的记录时，排序结果由 `id` 唯一确定。对应 6.5。适合属性测试。

### 并发类属性

- **P14 并发汇合**：同一用户的并发扣费请求，任意到达顺序下最终余额与流水集合相同。对应 5.7。适合属性测试：随机并发度与随机金额。
- **P15 超额并发安全**：余额只够 M 笔时并发提交 N 笔（N 大于 M），成功数恰为 M 且余额非负。对应 5.4。适合属性测试。
- **P16 跨用户不互斥**：用户 A 的长写操作进行中，用户 B 的写操作可以完成。对应 5.2。适合示例测试。

### 错误条件类属性

- **P17 非法分页参数**：任意越界或非数值的 `limit`、任意格式错误的 `cursor` 均返回 HTTP 400。对应 6.4。适合属性测试：随机非法输入。
- **P18 损坏输入不中断迁移**：Legacy_Store 中存在无法解析的 JSON 文件时，迁移仍完成其余记录并在报告中列出跳过项。对应 2.8。适合属性测试。
- **P19 越权访问**：使用其他用户的记录标识访问任一记录类接口，均返回 HTTP 404 且响应体不含该记录字段。对应 10.2。适合属性测试。

### 边界情况（不适合属性测试）

- 首次建库、schema 版本高于代码支持版本、数据库文件损坏：状态固定，用示例测试各覆盖 1 次。
- WAL 与 pragma 设置生效：读取 pragma 值断言，用示例测试覆盖。
- 阿里云 OSS 归档行为：属外部服务，沿用现有实现，用集成测试覆盖 1 到 2 个代表例。
- 性能门限（6.11、6.12、8.10）：用固定规模的基准测试度量，不用属性测试。
