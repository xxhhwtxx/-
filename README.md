# 发卡系统（MVP 到可运营化）

本仓库用于承载发卡系统的最小可用版本设计与实现基线，当前阶段先落地「库存 + 发卡 API + 订单记录」，并预留后续风控、渠道接入和自动化运营扩展能力。

## 1. 业务范围

- 发卡类型：支持**虚拟卡**优先，实体卡通过同一库存模型扩展（新增物流履约字段）。
- 卡库存来源：支持渠道批量导入、运营后台手工入库、API 入库。
- 发放触发方式：
  - 手动发卡（后台）
  - API 发卡（渠道系统直连）
  - 订单回调触发发卡（支付成功后自动履约）

## 2. 核心模块

- 用户与权限：管理员、渠道账号、终端用户三层角色隔离。
- 卡库存管理：卡池管理、入库、状态流转、锁定与释放。
- 发卡引擎：规则匹配、并发控制、幂等保障。
- 订单与履约：下单、支付、发卡、失败补偿。
- 通知与回执：短信/邮件/Webhook 回执。

详细模块设计见 `/home/runner/work/-/-/docs/architecture.md`。

## 3. 数据模型

核心实体：

- 用户（users）
- 卡池（card_pools）
- 卡密（cards）
- 订单（orders）
- 发卡记录（issue_records）
- 操作审计（audit_logs）
- 风控事件（risk_events）

详细模型见：

- `/home/runner/work/-/-/docs/data-model.md`
- `/home/runner/work/-/-/sql/schema.sql`

## 4. 关键业务流程

标准流程：下单 → 校验 → 锁卡 → 发卡 → 回执 → 结算  
覆盖机制：失败重试、库存回滚、重复请求防重

详见 `/home/runner/work/-/-/docs/flows.md`。

## 5. 安全与风控

- 卡密加密存储（应用层密文 + 密钥管理）
- 接口签名与时间窗防重放
- 权限隔离与最小权限
- 频控、黑名单、异常审计与告警

详见 `/home/runner/work/-/-/docs/security-observability.md`。

## 6. 运维与可观测性

- 日志（结构化 + 审计）
- 指标（库存、发卡成功率、履约耗时、失败率）
- 链路追踪（下单到发卡全链路）
- 告警规则与最小管理后台能力

## 7. 分阶段交付

详见 `/home/runner/work/-/-/docs/roadmap.md`：

1. MVP：库存 + 发卡 API + 订单记录
2. 增强：风控能力、管理后台、渠道接入
3. 运营化：自动化运营策略与数据化闭环

## 8. 最小初始化结构

```text
.
├── README.md
├── docs/
│   ├── architecture.md
│   ├── data-model.md
│   ├── flows.md
│   ├── security-observability.md
│   └── roadmap.md
├── openapi/
│   └── mvp-api.yaml
└── sql/
    └── schema.sql
```

## 9. MVP 服务（已实现）

当前仓库已提供一个可运行的 MVP 发卡服务（Node.js + SQLite）：

- 管理端：
  - `POST /v1/admin/channels` 创建渠道
  - `POST /v1/admin/card-pools` 创建卡池
  - `POST /v1/inventory/cards/import` 批量导入卡密
- 渠道端：
  - `POST /v1/orders` 创建订单并自动发卡（幂等）
  - `GET /v1/orders/{orderId}` 查询订单与发卡结果

默认内置演示数据：

- 渠道 API Key：`demo-api-key`
- 卡池：`pool-demo`
- 产品编码：`DEMO100`

### 本地运行

```bash
cd /home/runner/work/-/-
npm install
npm test
npm start
```
