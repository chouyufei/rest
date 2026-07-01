# 凤伯乐（Fengbole）· 后端开发说明

> 蛋品在线撮合 / 竞价平台的后端。配套前端在 `chouyufei/egg` 仓库
> （小程序 `miniprogram/` + Vue3 后台 `src/`）。整体产品约定见 egg 仓库的 `CLAUDE.md`。

**新会话续开**：代码即事实来源，全部已 commit+push。拉分支即可继续。

## 仓库 & 分支

- 本目录 `egg-platform/` 是后端（`chouyufei/rest` 是多项目仓库，后端在此子目录）。
- **开发分支**：`claude/egg-trading-platform-uYSOL`
- 流程：改动 → `commit` → `git push -u origin <branch>`。**不主动建 PR**，除非明确要求。

## 技术栈

- Node.js + Express + **better-sqlite3**（同步 API）
- JWT 鉴权；微信支付 V3 / `wechatpay-node-v3`；阿里云/腾讯云短信

## 结构

- `src/server.js` — 挂载 `/api/{auth,resources,bids,orders,deposits,messages,admin,upload,pay,wallet,reports}`
- `src/db.js` — 建表 + `addColumnIfMissing(...)` 增量迁移 + 一次性迁移 IIFE（用 `app_settings` 标记防重复）
- `src/middleware/auth.js` — `authRequired` / `roleRequired` / `sign` / `JWT_SECRET`
- `src/routes/` — 各业务路由
- `src/services/`：
  - `balance.js` — 钱包余额，**分位整数运算**（getBalance/txDebit/txPureDebit），debit 允许透支待对账
  - `auction.js` — 竞价：placeBidTx（含 notifyOutbid/notifyNewBidToPublisher）、settleOrderDeposits
  - `notification.js` — 站内信 + 分发（微信订阅 + 短信）；notifyNearbyOnPublish（附近推送）
  - `wechat-notify.js` — 微信订阅消息（单模板多场景，RESULT_TEXTS / templatesPublic）
  - `wecom-notify.js` — 企业微信机器人
  - `sms.js` — 短信；**按类型选模板 ID**（见下）
  - `geo.js` — `distanceKm`（Haversine）
  - `settings.js` — 平台可配项（服务保障金金额、push_radius_km、提现下限等）
  - `wechat-transfer.js` — 商家转账（transfer-bills，scene 1011，公钥模式）
  - `wechat-pay` 相关在 `routes/pay.js`

## 关键约定

- **鉴权**：`authRequired` 校验 Bearer JWT；公开接口（游客可访问）无此中间件：
  `GET /resources`（列表）、`GET /resources/:id`（详情）、`GET /resources/seller/:userId`（卖家信用）。
- **角色与资质解耦**：`switch-role` / 登录切角色**只改 role，不动 `license_status`**；
  新用户以 `license_status='none'` 创建（`pending` 只表示"确实提交待审核"）。
  `/auth/qualify` 任何登录用户可提交；`approved` 用户重新提交存 `license_pending` 快照，
  审核通过时由 admin 用快照覆盖正式字段（`/admin/users/:id/approve`）。
- **resources**：`kind`(supply/demand)、`weight_specs`(JSON)、`allow_provinces`(JSON,求购)、
  `truck_type`、`deleted_at`(软删) 等。**relist** UPDATE 需包含 `weight_specs` 与 `allow_provinces`
  （未回传时沿用旧值，避免清空——历史坑）。
- **服务保障金**：后台可配金额，只扣卖方；订单 confirm 时先 settle 再 release，扣完整服务费。
- **余额比较**一律**分位整数**，杜绝 IEEE-754 误判（"够却提示不够"）。
- **短信按模板 ID 区分类型**（模板不支持参数）：
  `sendUserNotice(phone, title, 类型)` → 订单提醒 `2657517` / 报价提醒 `2673307` / 货源提醒 `2673308`；
  平台方 `2657523`。可用 env `SMS_NOTICE_TPL_ORDER/QUOTE/SUPPLY` 覆盖。
- **提现**：微信零钱单笔 ≤200 实时到账；银行卡单笔 ≤5000 两小时内到账。转账失败→退款、状态置 failed。

## 环境变量（要点）

- `JWT_SECRET`
- 短信：`SMS_PROVIDER`(aliyun/tencent) / `SMS_SIGN_NAME` / `SMS_TEMPLATE_CODE`(验证码) /
  `SMS_ACCESS_KEY_ID` / `SMS_ACCESS_KEY_SECRET` / `SMS_NOTICE_TPL_ORDER|QUOTE|SUPPLY` /
  `SMS_NOTICE_PLATFORM_TEMPLATE`
- 微信支付/转账：`WECHAT_*`（含公钥模式 `WECHAT_PLATFORM_PUBLIC_KEY` / `WECHAT_PLATFORM_PUBLIC_KEY_ID`）
- 缺短信/支付配置时走 demo 模式（控制台打印，不真正发送）。

## 校验 & 沙箱备注

- 改完用 `node --check <file>` 做语法自检。
- 本沙箱 libreoffice docx→pdf 不可用；生成 PDF 用 Chromium（`/opt/pw-browsers/...`）HTML→PDF。

## 语言

回复与提交说明用中文。
