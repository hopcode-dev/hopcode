# 安全审计修复计划 — 全量修复（Critical → Low）

## Context
开源发布前安全审计发现约22个问题，经"World's #1 Hacker"二次审核后补充了多个遗漏。全部修复后再上传GitHub。

## 修改文件
- `src/server-node.ts` — 主UI服务（大部分修复）
- `src/pty-service.ts` — PTY服务
- `src/shared/protocol.ts` — 内部通信协议
- `Dockerfile` — 容器安全
- `src/quick.ts` — 启动器

---

## Critical

### Group 1: 密码哈希 + timingSafeEqual
**文件**: `src/server-node.ts`
- 单用户: `AUTH_PASSWORD` 用 `scryptSync(password, salt, 64)` 哈希存储
- **多用户**: `users.json` 密码也必须哈希存储（当前明文 + `===` 比较）
- 所有密码比较改用 `timingSafeEqual`（注意：需先确保 buffer 等长）
- `verifyAuthToken()` 中 HMAC 比较也用 `timingSafeEqual`

### Group 2: PTY 内部 Token — HMAC 派生
**文件**: `src/shared/protocol.ts`, `src/pty-service.ts`, `src/server-node.ts`
- 当前: `'pty_internal_' + base64(password)` — 可逆泄露明文
- 改为: `createHmac('sha256', password).update('pty-internal-token').digest('hex')`
- PTY service 的 token 比较 (`===`) 也改用 `timingSafeEqual`

### Group 3: CSRF Origin 检查 + WebSocket 保护
**文件**: `src/server-node.ts`
- POST/PUT/DELETE 检查 `Origin`/`Referer`，不匹配 → 403
- WebSocket upgrade 也检查 Origin（防跨站 WebSocket 劫持 → 远程命令执行）
- 虽然 `SameSite=Lax` 在现代浏览器有一定保护，但 Origin 检查是必要的纵深防御

---

## High

### Group 4: 删除 LEGACY_AUTH_TOKEN
**文件**: `src/server-node.ts`
- 删除所有 `LEGACY_AUTH_TOKEN` 引用及回退逻辑

### Group 5: 全局请求体大小限制
**文件**: `src/server-node.ts`
- 文件上传: 100MB 限制（`/terminal/file-upload` 和 `/terminal/upload` 两个端点都要）
- 其他 POST 端点（login、rename 等）: 1MB 限制
- 流式读取时累计字节数，超限立即中止 + 返回 413

### Group 6: WebSocket 消息大小 + 速率限制
**文件**: `src/server-node.ts`, `src/pty-service.ts`
- 终端 WS: 单条消息上限 1MB，速率限制（防 PTY 洪泛）
- Voice WS: `allChunks` 缓冲区上限 50MB，`pendingChunks` 上限
- 超限断开连接

### Group 7: 错误信息脱敏
**文件**: `src/server-node.ts`, `src/pty-service.ts`
- catch 块返回通用 "Internal server error"，不泄露 `e.message`
- 详细错误只写 `console.error`

### Group 8: 静态资源路径穿越防护
**文件**: `src/server-node.ts`
- `/icons/*` 等静态路由: `path.resolve()` 后验证在 `public/` 目录内
- 文件浏览器: 已认证用户可访问整个文件系统（设计如此），但 `resolveSafePath` 函数名误导 — 重命名为 `canonicalizePath` 并加注释说明

### Group 9: PTY 环境变量白名单
**文件**: `src/pty-service.ts`
- 单用户模式不再传 `process.env` 全量
- 白名单: `PATH, HOME, USER, SHELL, TERM, LANG, LC_ALL, EDITOR, COLORTERM, TERM_PROGRAM`
- 确保 `AUTH_PASSWORD` 等敏感变量不泄露到 shell（用户输入 `env` 看不到）

### Group 10: BIND_HOST 可配置
**文件**: `src/server-node.ts`, `src/pty-service.ts`
- UI 服务默认绑定 `127.0.0.1`（当前是 `0.0.0.0`，不安全）
- `BIND_HOST` 环境变量可覆盖
- PTY 服务始终绑定 `127.0.0.1`

### Group 11: 内存增长边界
**文件**: `src/server-node.ts`
- `loginAttempts` Map: 定时清理过期条目（每5分钟），最大 10000 条目
- Voice `allChunks`: 设上限 50MB
- 超限时拒绝新条目或断开连接

---

## Medium

### Group 12: TRUST_PROXY 配置
**文件**: `src/server-node.ts`
- `TRUST_PROXY` 环境变量（默认 false）
- 只在 true 时信任 `X-Forwarded-For`（否则攻击者可绕过速率限制）
- 与 Group 1 配合：速率限制依赖 IP，IP 获取必须安全

### Group 13: Session rename 鉴权
**文件**: `src/server-node.ts`
- rename 端点添加 `isAuthenticated(req)` 检查（如已有则确认 session ownership）
- 与 delete 端点保持一致

### Group 14: Content-Disposition 文件名消毒
**文件**: `src/server-node.ts`
- 过滤 `\r\n` 等注入字符
- 用 RFC 5987: `filename*=UTF-8''${encodeURIComponent(name)}`
- 涉及多个下载端点

### Group 15: 文件浏览器 Symlink 处理
**文件**: `src/server-node.ts`
- `lstat` 替代 `stat` 检测符号链接
- symlink 标记在文件列表中显示

---

## Low

### Group 16: CDN 资源 SRI 哈希
**文件**: `src/server-node.ts`
- 所有 CDN `<script>` / `<link>` 添加 `integrity` + `crossorigin="anonymous"`
- xterm.js, xterm-addon-fit, xterm-addon-webgl

### Group 17: Dockerfile 非 root 用户
**文件**: `Dockerfile`
- `RUN useradd -m hopcode` + `USER hopcode`
- 注意: 多用户 `su -` 需要 root — 可能需要拆分或用 capability

### Group 18: CSP 加固（移除 unsafe-inline）
**文件**: `src/server-node.ts`
- 当前 `script-src 'self' 'unsafe-inline'` 使 XSS 保护失效
- 长期目标: 将内联 JS 抽到外部文件，使用 nonce
- 短期: 评估可行性，如果内联 JS 太多则标记为 TODO

---

## 已知限制（不在本次修复范围，记录为 TODO）
1. **Auth token 永不过期**: 当前 HMAC token 确定性生成、不可撤销。完整修复需要引入 session store（如 SQLite），超出本次范围
2. **URL token 泄露到 Cloudflare 日志**: 初始请求含 token，Cloudflare 基础设施可见。可考虑单次使用 token，但需要 server-side state
3. **CSP unsafe-inline 完整移除**: 整个 UI 是服务端生成的 HTML + 内联 JS，完全移除需要大幅重构

---

## 实施顺序
按组号顺序：Critical (1-3) → High (4-11) → Medium (12-15) → Low (16-18)

## 验证
1. `npx tsx src/server-node.ts` — 启动正常
2. 登录流程 — 密码验证正常（scrypt 哈希）
3. `?token=xxx` URL 认证 — 可用
4. 终端 — PTY 连接、输入输出正常
5. 文件浏览器 — 上传/下载/浏览正常，超 100MB 被拒绝
6. Session 管理 — 创建/重命名/删除正常
7. `curl -X POST -H "Origin: https://evil.com"` — CSRF 拒绝 403
8. 终端内 `env` — 不显示 `AUTH_PASSWORD`
9. `curl` 路径穿越 `/icons/../../etc/passwd` — 403
10. Docker build + run — 正常工作
