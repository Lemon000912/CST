# 微信支付 Native 扫码支付（API v3）

## 架构

本功能只在校园版启用。支付弹窗使用校园版专用前端模块并只进入校园版构建产物；企业版不包含充值页面、二维码代码或本次新增的微信支付 API 路由。校园版积分充值复用现有 `point_recharge_orders`、`point_wallets` 和不可变积分流水 `point_ledger`。浏览器只提交套餐 ID；服务端从 `backend/recharge.js` 的套餐目录取得金额和权益，创建本地订单后调用微信支付 Native 下单。浏览器使用原始 `code_url` 生成二维码，并每 2 秒查询本地订单，最多轮询 5 分钟。

微信支付服务器调用 `/api/pay/wechat/notify`。服务端先用原始 HTTP body、四个 `Wechatpay-*` 请求头和 `pub_key.pem` 验签，再用 APIv3 密钥执行 AES-256-GCM 解密。AppID、商户号、订单号、人民币币种、金额和交易号全部匹配后，才在同一数据库事务中把订单改为 `paid` 并增加积分。重复通知只返回已有结果，不重复入账。

## 环境变量

生产环境在现有 `/home/ubuntu/ailunwen-secrets/ailunwen.env` 中只追加以下内容，不要覆盖原文件：

```env
WECHAT_PAY_APP_ID=YOUR_WECHAT_PAY_APP_ID
WECHAT_PAY_MCH_ID=YOUR_WECHAT_PAY_MCH_ID
WECHAT_PAY_MCH_SERIAL_NO=YOUR_WECHAT_PAY_MCH_SERIAL_NO
WECHAT_PAY_API_V3_KEY=YOUR_32_BYTE_API_V3_KEY
WECHAT_PAY_PRIVATE_KEY_PATH=/home/ubuntu/wechatpay/cert/apiclient_key.pem
WECHAT_PAY_PUBLIC_KEY_PATH=/home/ubuntu/wechatpay/cert/pub_key.pem
WECHAT_PAY_PUBLIC_KEY_ID=PUB_KEY_ID_YOUR_WECHAT_PAY_PUBLIC_KEY_ID
WECHAT_PAY_NOTIFY_URL=https://syncsee.cstdata.net/api/pay/wechat/notify
WECHAT_PAY_TEST_MODE=false
WECHAT_PAY_TEST_AMOUNT_FEN=1
```

`apiclient_key.pem` 是商户 API 证书私钥，用于商户请求签名；`pub_key.pem` 是微信支付公钥，用于验证微信的响应和回调。两者不可互换。商户证书序列号必须与当前 `apiclient_key.pem` 配套，公钥 ID 必须与 `pub_key.pem` 配套。

## 服务器配置

```bash
sudo install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/wechatpay/cert
sudo install -m 600 -o ubuntu -g ubuntu /安全上传目录/apiclient_key.pem /home/ubuntu/wechatpay/cert/apiclient_key.pem
sudo install -m 600 -o ubuntu -g ubuntu /安全上传目录/pub_key.pem /home/ubuntu/wechatpay/cert/pub_key.pem
sudo nano /home/ubuntu/ailunwen-secrets/ailunwen.env
sudo systemctl restart ailunwen-school-api.service
sudo journalctl -u ailunwen-school-api.service -n 100 --no-pager
```

若支付仅用于校园版，只需把微信支付变量提供给校园版进程。启动日志出现 `Native 支付配置检查通过` 才表示变量、文件、APIv3 密钥长度和 PEM 格式均通过本地检查。

公网代理必须把 `POST /api/pay/wechat/notify` 原样转发到 API，不得重写 JSON body。回调地址必须能从公网通过 HTTPS 访问，不要求 JWT 登录。

## API

- `POST /api/pay/wechat/native`：登录后提交 `{ "planId": "cny100_points1000" }` 创建 Native 订单；可带 `Idempotency-Key`。
- `GET /api/pay/wechat/orders/:outTradeNo/status`：登录后查询本人订单的本地状态。
- `POST /api/pay/wechat/notify`：微信支付异步通知，无 JWT，严格验签。

兼容期内原积分充值 API 仍保留，现有支付宝功能不受影响。

## 测试

测试不会访问微信真实接口：

```bash
cd /home/ubuntu/ailunwen-current
npm ci
npm test
npm run build:school
```

仅在本机或测试环境可临时设置：

```env
NODE_ENV=development
WECHAT_PAY_TEST_MODE=true
WECHAT_PAY_TEST_AMOUNT_FEN=1
```

只要 `NODE_ENV=production`，测试金额覆盖会被强制忽略，订单仍使用服务器套餐的真实价格。

## 日志与订单检查

```bash
sudo journalctl -u ailunwen-school-api.service -f | grep '\[WechatPay\]'
```

PostgreSQL 只读检查：

```sql
SELECT order_no, user_id, package_id, amount_fen, status,
       provider_transaction_id, paid_at, created_at, expires_at
FROM point_recharge_orders
WHERE provider = 'wechat'
ORDER BY created_at DESC
LIMIT 20;
```

日志只记录商户订单号、交易号、状态和有限错误代码，不记录私钥、APIv3 密钥或完整 Authorization。

## 排障

Native 下单失败时，先查看启动配置检查和 `[WechatPay]` 日志，确认商户号与 AppID 已绑定、商户证书序列号匹配、服务器时间准确、两个 PEM 可由服务用户读取。HTTP 401/签名错误重点检查商户私钥和序列号；响应验签错误重点检查公钥 ID 与 `pub_key.pem`。

收不到回调时，确认商户平台实际订单的通知地址为 `https://syncsee.cstdata.net/api/pay/wechat/notify`，公网 HTTPS 证书有效，代理允许 POST 且未修改 body。验签失败时确认代理未解析后重新序列化 JSON，并确认请求头 `Wechatpay-Serial` 等于配置的公钥 ID。

订单长期 `PENDING` 时先在微信商户平台按商户订单号核对，再查服务日志。不要直接改数据库为 `PAID`；权益只能由验签通过的回调事务发放。

## 密钥安全

仓库 `.gitignore` 已忽略 `*.pem` 和生产 `.env`。禁止把私钥、公钥文件、APIv3 密钥或生产环境文件加入 Git、前端代码、日志、截图和聊天内容。部署前可检查：

```bash
git status --short
git ls-files '*.pem' '.env' '.env.production'
```

第二条命令应无输出。若密钥曾泄露，立即在微信支付商户平台轮换对应密钥或证书。
