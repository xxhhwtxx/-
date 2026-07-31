# 数据模型设计

## 1. 实体概览

- users（用户）
- channels（渠道）
- card_pools（卡池）
- cards（卡密库存）
- orders（订单）
- issue_records（发卡记录）
- audit_logs（操作审计）
- risk_events（风控事件）

## 2. 关键关联

- channels 1:N users
- card_pools 1:N cards
- channels 1:N orders
- orders 1:1 issue_records（一次订单一次发卡；多次重试写同记录的重试计数）
- orders 1:N risk_events
- 任意业务实体 1:N audit_logs

## 3. 关键约束

- cards.card_no 唯一
- orders.idempotency_key 唯一（按渠道维度可组合唯一）
- issue_records.order_id 唯一
- cards.status 与 lock_expired_at 配合保证锁超时可回收

## 4. 审计与追踪

- 所有写操作记录 actor、source_ip、request_id
- 关键链路透传 trace_id：下单、支付、发卡、回执
