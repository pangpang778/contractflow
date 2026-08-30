# T1 会话域（seam S1）· ready-for-agent（C3 预授权）

`blockedBy: []` — 域本身就是起点，无上游。
目标：把登录/校验/吊销/过期/锁定/持久化收敛为可测的纯逻辑；密码 scrypt+盐哈希为安全路径如约落地。

## 交付切片
- **server/auth.js（新模块，认证域）**：
  - `hashPassword(password, salt, cost)`：scrypt 哈希（hex）+ 可注入 cost（生产高、测试低）；`verifyPassword(password, salt, expectedHash, cost)` 用 `timingSafeEqual` 常数时间比较。
  - `createSessionStore({ file, now })`：
    - 加载用户库（`users.json`：`[{id, username, role, password_hash, salt}]`，按 username 建索引）；再加载既有会话（`sessions.json`）到内存 Map，丢弃已过期者（重启恢复在线）。
    - **login(username, password)** → 成功 `{ token, userId, role, expiresAt }`（并持久化会话 + 重置该用户名失败计数）；失败（错密码或用户不存在，同样 401）→ `throw {code:'UNAUTHORIZED'}` 且失败计数+1；连续 ≥`LOCK_THRESHOLD=5` 次 → 置 `lockedUntil`（`now()+LOCK_MS=15min`）。锁定态在内存 Map（username → `{fails, lockedUntil}`），重启清零。
    - **login 锁定** → `throw {code:'LOCKED', retryAfter}`（锁定期间正确密码也拒）。
    - **validate(token)** → `{userId, role, expiresAt}` 或 null（未过期的活动会话；过期/未知 → null 且惰性删）。
    - **revoke(token)** → 删除会话 + 持久化（logout 用）。
  - token = `randomBytes(32).toString('hex')`；会话有效期 `SESSION_TTL=8h`（自创建起固定时长）。
  - 对外导出 `SESSION_TTL_MS`、`LOCK_THRESHOLD`、`LOCK_MS` 常量（测试直接断言）。

## 验收条件（机械可判）
1. scrypt 往返：`verifyPassword` 对正确密码 true、错误密码 false；同一 (password,salt,cost) 两次哈希结果一致（确定性，便于常数时间验证）。
2. 登录成功：返回 8h 内过期的 `expiresAt`、`{userId, role}` 可经 `validate(token)` 还原；会话落盘（读 `sessions.json` 存在该 token）。
3. 过期：`now()` 拨到过期后 `validate` → null 且会话被清。
4. 吊销：`revoke` 后 `validate` → null。
5. 锁定：连续 5 次错密码 → 第 5 次起 `login`（含正确密码）抛 423 `LOCKED` 且 `retryAfter≈15min`；成功登录重置失败计数（锁前）。
6. 持久化恢复：重建 SessionStore（同文件）后未过期会话仍可 `validate`。
7. 用户不存在与密码错误同一 401（不泄露用户是否存在）。

## 演示/验证（S1）
`node --test`：上述单测通过；用低成本 cost 防套件拖慢。