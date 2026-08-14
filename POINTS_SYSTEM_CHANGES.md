# 积分系统改造说明

> 生成日期：2026-08-07
> 分支：main
> 改动规模：10 个文件修改 + 4 个新文件，+1530 / -204 行

---

## 一、背景与目标

项目原有"免费阅读 5 篇"机制实际只是每日 PDF 点击计数器（`/api/v1/pdf-click`）加第 6 次前端提示，不阻断访问、不扣费、可绕过。本次改造用服务端权威积分账户替换该演示规则，并覆盖搜索文字、图表数据点、PDF 文件三类消费场景。

**确认的规则（来自需求讨论）：**

| 场景 | 收费标准 | 备注 |
|---|---|---|
| 新用户注册 | 赠送 1000 积分 | 仅注册时一次 |
| 已有用户（上线前） | 补发 1000 积分 | 幂等，重启不重复 |
| 搜索回答文字 | 0.05 积分/Unicode 字符 | 仅 synthesis + deepSynthesis |
| 图表数据点 | 0.1 积分/有效逻辑点 | 仅 LLM 提取成功的点；fallback 合成点免费 |
| PDF 文件 | 1 积分/文件 | 普通 PDF：服务端成功获取并验证；深度 PDF：MinerU 解析成功 |
| 余额耗尽 | 流式回答在余额归零时立即停止并提示充值 | 任何操作均不得将余额扣成负数 |

---

## 二、新增文件

### `backend/billing.js`

积分系统核心服务，所有扣费逻辑集中在此，不分散到路由中。

**价格常量（整数 units，避免浮点误差）：**
```
1 积分 = 20 units
字符    = 1 unit   → 0.05 积分/字符
图表点  = 2 units  → 0.10 积分/点
PDF     = 20 units → 1.00 积分/文件
初始赠送 = 20000 units → 1000 积分
```

**核心 API：**
- `beginBillableOperation` — 检查余额 > 0，同用户只允许一个 processing 操作（数据库唯一部分索引），同幂等键同请求哈希直接重放，不同请求返回 409
- `completeBillableOperation` — 原子写：更新钱包余额 + 追加不可变 ledger + 保存完整响应和收据；余额不足时拒绝超额扣费
- `failBillableOperation` — 结束操作状态，不扣费
- `getPointBalance` / `getBillableOperation` — 只读查询
- `countUnicodeCodePoints` — 按 Unicode code point 计数（`Array.from().length`），正确处理中文、emoji、代理对
- `stableRequestHash` — 对象 key 排序后 SHA-256，保证幂等键不被不同请求复用
- `formatPointUnits` — 整数 units 转为精确两位小数字符串，无浮点误差

**错误类型：**
- `BillingError(code, message, status)` — 结构化计费错误
- `BillingUnavailableError` — 计费数据库不可用（503）

### `backend/pdfFulfillment.js`

服务端安全 PDF 获取，替代浏览器直接访问 `pdfUrl`。

**SSRF 防护（逐跳验证）：**
- 拒绝非 HTTP/HTTPS 协议
- 拒绝 URL 中含认证信息
- DNS 解析后检查所有 IP：localhost、10.x、172.16-31.x、192.168.x、169.254.x（链路本地）、云元数据地址等全部阻断
- 限制最大重定向次数（默认 4）、下载超时（默认 20s）、文件大小（默认 20MB）
- 校验响应头 Content-Type 和文件 `%PDF-` 签名

### `backend/test/billing.test.js`

Node 内置测试运行器，9 个测试全部通过：
- 价格常量完整性
- Unicode/emoji/组合字符按 code point 计数
- 积分格式化无浮点误差（包括负数）
- 稳定哈希忽略对象 key 插入顺序
- 循环引用和非有限数值拒绝
- 费用计算拒绝非法入参
- PDF 来源安全校验：非 HTTP scheme、私网字面地址、URL 含认证信息

### `package.json`（新增 `test` 脚本）
```json
"test": "node --test backend/test/*.test.js"
```

---

## 三、修改文件

### `backend/db.js`

**数据库结构（新增三张表，PostgreSQL 和 SQLite 双方言）：**

```sql
-- 积分钱包（余额有符号，允许负数）
point_wallets (
  user_id TEXT PRIMARY KEY,
  balance_units INTEGER/BIGINT NOT NULL,
  created_at, updated_at
)

-- 可计费操作（幂等键 + 请求哈希 + 状态机 + 租约）
point_operations (
  id, user_id, operation_type, idempotency_key,
  request_hash, status CHECK('processing','completed','failed'),
  cost_units, billing_details_json, result_json, receipt_json,
  error_code, lease_expires_at, lease_token,
  created_at, updated_at, completed_at
  UNIQUE(user_id, operation_type, idempotency_key)
)
-- 部分唯一索引：同一用户最多一个 processing 操作
CREATE UNIQUE INDEX point_operations_one_processing_per_user
  ON point_operations(user_id) WHERE status = 'processing'

-- 不可变账本
point_ledger (
  id, user_id, operation_id, entry_type,
  idempotency_key, delta_units, balance_after_units,
  metadata_json, created_at
  UNIQUE(user_id, idempotency_key)
)
-- PostgreSQL：trigger 阻止 UPDATE/DELETE/TRUNCATE
-- SQLite：trigger 阻止 UPDATE/DELETE
```

**事务支持（`withDatabaseTransaction`）：**
- PostgreSQL：`BEGIN` / `COMMIT` / `ROLLBACK` + dedicated client，`FOR UPDATE` 行锁
- 原生 SQLite（sqlite3）：`BEGIN IMMEDIATE` 事务
- sql.js（内存 SQLite）：事务前快照，提交后一次原子 `rename` 落盘，失败时内存回滚到快照；进程锁文件防止多进程并发写坏数据库

**用户创建原子化：**

`createUserRecord` 在同一事务中完成：插入 `users` + 插入 `point_wallets(20000)` + 插入 `signup_grant` ledger。任意步失败完整回滚，不会出现"有账号、无钱包"状态。

**已有用户回填（`backfillPointWallets`，启动时执行）：**

对所有没有钱包的用户执行一次性补发，通过 `ON CONFLICT DO NOTHING` 和唯一约束保证幂等，服务器多次重启不重复赠送。

### `backend/auth.js`

- 新增 `requireAuthenticatedUser` 中间件：验证 Bearer JWT → 数据库重新确认用户存在 → 写入 `req.auth.userId`
- 注册响应新增 `billing` 字段（服务端余额）
- 登录响应新增 `billing` 字段
- `/me` 端点新增 `billing` 字段，并验证用户是否仍存在

### `backend/index.js`

**新增路由：**

| 路由 | 认证 | 说明 |
|---|---|---|
| `GET /api/v1/billing/balance` | ✓ | 返回余额、可用余额、价格表 |
| `GET /api/v1/billing/operations/:id` | ✓ | 查询操作收据（只本人可查）|
| `GET /api/v1/billing/recharge/catalog` | ✓ | 返回 100 元 / 1000 积分套餐及已启用支付通道 |
| `POST /api/v1/billing/recharge/orders` | ✓ | 创建支付宝当面付或微信 Native 扫码订单 |
| `GET /api/v1/billing/recharge/orders/:id` | ✓ | 查询本人充值订单状态 |
| `POST /api/v1/billing/recharge/callback/:provider` | 平台验签 | 支付宝/微信异步通知，幂等入账 |
| `POST /api/v1/pdfs/fulfill` | ✓ | 服务端安全获取 PDF，成功扣 1 积分 |

**修改路由：**

`POST /api/v1/search`（双层路由设计）：
1. 第一层：`requireAuthenticatedUser` + `Idempotency-Key` 校验 + `beginBillableOperation`（余额 ≤ 0 则 402）
2. 拦截 `res.json`：操作结果正常时原子结算 → 插入 ledger → 完整响应写入 `result_json` → 返回含 `billingReceipt` 的响应
3. 计费范围：`synthesis` + `deepSynthesis` 的 Unicode code point 数 + 当次操作内 `mineru:ok` 的唯一 PDF 文件数
4. 同幂等键重放：直接返回存储结果，不重新执行搜索，不重复扣费
5. 任何异常（包括序列化失败）调用 `failBillableOperation`，不扣费

`POST /api/v1/chart/from-papers`（双层路由设计）：
1. 第一层：认证 + 幂等键 + 从**父搜索操作存储结果**取论文（不信任客户端提交的任意 papers）
2. 按 `res.locals.chartBillingSource`（`"llm"` 或 `"fallback"`）区分来源：LLM 提取点按实际数量计费，fallback 合成点收费 0
3. PNG 或 SVG fallback 任意一种成功才结算，全部失败不扣费

**废弃路由：**
- `POST /api/v1/pdf-click` → 410 Gone
- `POST /api/search`（旧版）→ 410 Gone

**辅助函数（新增）：**
- `sendStructuredError` — 统一 `BillingError` / `ApiRouteError` / `PdfFulfillmentError` 响应格式
- `requireIdempotencyKey` — 验证 `Idempotency-Key` 请求头
- `failOperationBestEffort` — 路由异常时 best-effort 结束操作
- `searchBillingDetails` — 从 payload 提取 synthesis/deepSynthesis 字符数和唯一成功 PDF 数
- `getStoredSearchPapers` — 从父操作结果提取论文列表
- `pdfArtifactCache` — 8条 LRU 内存缓存，供幂等重试复用已获取的 PDF bytes

### `backend/seedDevAdmin.js`

开发管理员 seed 改用统一的 `createUserRecord`，确保 dev admin 账号也有积分钱包。

### `frontend/src/types.ts`

新增类型：
```typescript
PointBalance    // userId, balanceUnits, availableUnits, balance
Pricing         // unitsPerPoint, characterUnitCost, chartPointUnitCost, pdfUnitCost
BillingLineItem // 收据明细行
BillingReceipt  // operationId, costUnits, cost, balanceUnits, balance, billingDetails
```

`SearchResultMeta` 新增字段：
- `billing?: BillingReceipt` — 搜索操作收据
- `parentOperationId?: string` — 供图表操作引用
- `paperChart.billing?: BillingReceipt` — 图表收据

`Paper` 新增 `pdfSourceId?: string` — 服务端 PDF 交付引用 ID

### `frontend/src/api.ts`

- 新增 `ApiError` 类（含 `status`、`code`、`details`、`balance` 字段）
- 新增 `createIdempotencyKey()` — `crypto.randomUUID()`
- 新增 `fetchPointBalance()` — 查询余额和价格表
- `searchPapersV1` — 携带 `Idempotency-Key` header，返回包含 `billingReceipt` 和 `parentOperationId`
- `requestPaperChartFromPapers` — 新增必填 `parentOperationId`，携带幂等键
- 新增 `fulfillPdf` — 认证 POST + `Idempotency-Key`，返回 Blob + 解析后的 `BillingReceipt`
- 移除 `trackPdfOpen`（旧版 BR-006）

### `frontend/src/authApi.ts` / `authSession.ts`

注册/登录响应解析 `billing` 余额，存入 `AuthProfile` 供后续界面初始化使用。

### `frontend/src/App.tsx`

**余额显示：**
- 侧栏账号区：`积分 XXX.XX`（实时更新）
- 移动端头部：`XXX.XX 积分`
- 每次搜索/图表/PDF 完成后调用 `applyReceipt` 更新余额

**价格说明（发送区底部常驻）：**
```
回答文字 0.05 积分/字符 · 图表自动生成 0.1 积分/有效数据点 · PDF 1 积分/文件
```

**余额保护：**
- `billingDisabled = pointBalance.balance <= 0`
- 余额 ≤ 0 时：发送按钮禁用、图表禁用、PDF 禁用，显示“积分已用完，请充值后继续使用”

**自动图表（搜索后）：**

仅在搜索结算后余额仍 > 0 时自动触发图表请求，否则显示"余额不足，未自动生成图表"

**PDF 按钮：**

PDF / 下载 / OA 按钮改为调用 `fulfillPdf` 经服务端认证授权获取 Blob，用 `URL.createObjectURL` 打开或触发下载，成功后更新余额和显示 1 积分收据

**收据显示：**

每条搜索消息和图表结果附近显示：`消费 X.XX 积分 · 余额 XXX.XX`

---

## 四、验证结果

```
npm test   → 9/9 通过
npm run build → TypeScript 无错误，Vite 构建成功
```

---

## 五、已知局限（后续迭代）

| 项 | 说明 |
|---|---|
| OA Unpaywall | OA 按钮有条件接入 `fulfillPdf`，但 Unpaywall 仅返回落地页时仍走旧逻辑（不扣费）；完整接入需服务端 resolve DOI |
| 退款/调账 | 扫码充值已实现；退款负向流水和管理员调账仍需后续实现 |
| 余额校验 | 目前无定期核账脚本（钱包余额 vs ledger 累计），建议后续加 cron 校验 |
| PostgreSQL 多实例 | 架构已为 PG 多实例做好准备（行锁、事务），但 sql.js 模式仍限单进程 |
| 端到端测试 | 已覆盖 SQLite 充值入账和重复回调；支付平台沙箱及 PostgreSQL 并发回调仍需部署环境联调 |

---

## 六、上线检查清单

- [ ] 已有用户首次启动时会自动补发 1000 积分（日志关键字：`[db] 已对 N 个用户补发积分`）
- [ ] 生产环境 `JWT_SECRET` 已配置（≥ 32 字符）
- [ ] 前端使用新版构建产物（包含 `Idempotency-Key` header）
- [ ] 旧客户端若还在发 `POST /api/v1/pdf-click` 会收到 410，不影响核心功能
- [ ] 搜索请求必须携带 Bearer Token，未登录用户会收到 401（确认前端 AuthGate 已生效）
