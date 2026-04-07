# Hopcode 安装指南（新服务器 / Lima02）

本文档针对全新 Ubuntu 24.04 服务器，从零开始完整安装 Hopcode。

---

## 0. 前提条件检查

- Ubuntu 24.04（测试于 22.04 同样适用）
- 你有服务器的 **root 或 sudo 权限**
- 域名（可选，用于 HTTPS）
- 云服务器的安全组已开放：22（SSH）、3000（Hopcode）

```bash
# 确认当前用户和系统
whoami          # 应该是 jack 或有 sudo 的用户
cat /etc/os-release | grep PRETTY
```

---

## 1. 系统依赖

### 1.1 更新系统 + 安装基础工具

```bash
sudo apt-get update
sudo apt-get install -y curl git unzip sudo
```

### 1.2 Node.js 22（PTY service 必须用 Node.js，不能用 Bun）

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # 确认 v22.x
npm install -g tsx
```

### 1.3 Bun（UI service 用 Bun 运行）

```bash
curl -fsSL https://bun.sh/install | bash
# 安装后 bun 在 ~/.bun/bin/bun，加到 PATH
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
bun --version   # 确认安装成功
```

### 1.4 PM2（进程管理）

```bash
sudo npm install -g pm2
pm2 --version    # 确认安装成功
```

### 1.5 Nginx + Certbot（HTTPS 反向代理）

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx --version  # 确认
```

### 1.6 Playwright 浏览器（可选，Playwright MCP 需要）

```bash
# 安装 Chromium（用于浏览器自动化）
npx playwright install chromium
# 或指定路径：
npx playwright install --chromium /opt/puppeteer-cache/chrome/linux-146.0.7680.31
```

---

## 2. 用户和权限配置

### 2.1 确保 hopcode 用户存在

```bash
# 创建 hopcode 用户（如果不存在）
sudo useradd -m -s /bin/bash hopcode

# hopcode home 目录权限：711 — 服务需要 traverse 但不需要读取内容
sudo chmod 711 /home/hopcode
```

### 2.2 给当前用户（jack）sudo 免密码（方便操作）

```bash
echo 'jack ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/jack
sudo chmod 440 /etc/sudoers.d/jack
```

### 2.3 hopcode 用户 sudo 权限（服务管理用）

```bash
sudo tee /etc/sudoers.d/hopcode > /dev/null << 'EOF'
hopcode ALL=(ALL) NOPASSWD: ALL
EOF
sudo chmod 440 /etc/sudoers.d/hopcode
```

---

## 3. 代码部署

### 3.1 以 hopcode 用户 clone 代码

```bash
# 先给 hopcode 用户目录权限（否则 clone 失败）
sudo chmod 755 /home/hopcode

# 以 hopcode 用户 clone
sudo -u hopcode git clone https://github.com/hopcode-dev/hopcode.git /home/hopcode/hopcode

# 确认代码在位
ls /home/hopcode/hopcode/
```

### 3.2 安装项目依赖

```bash
cd /home/hopcode/hopcode
sudo -u hopcode /home/hopcode/.bun/bin/bun install
```

### 3.3 一键安装脚本（懒人版）

在 `/home/hopcode/hopcode/scripts/` 里有辅助脚本，可参考：

```bash
ls /home/hopcode/hopcode/scripts/
```

---

## 4. 环境配置

### 4.1 ecosystem.config.cjs

这是最核心的配置文件。参考示例在项目根目录：

```bash
cat /home/hopcode/hopcode/ecosystem.config.cjs
```

**必须配置的项目：**

```js
// /home/hopcode/hopcode/ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'hopcode-pty',
      script: '/home/hopcode/hopcode/start-pty.sh',
      cwd: '/home/hopcode/hopcode',
      autorestart: true,
      watch: false,
      env: {
        AUTH_PASSWORD: '你的强密码',  // 必须与 hopcode-ui 一致
      },
    },
    {
      name: 'hopcode-ui',
      script: '/home/hopcode/hopcode/start-ui.sh',
      cwd: '/home/hopcode/hopcode',
      autorestart: true,
      watch: false,
      env: {
        HOME: '/home/hopcode',
        AUTH_PASSWORD: '你的强密码',
        // Volcano Engine 语音（可选）
        VOLCANO_APP_ID: '你的APP_ID',
        VOLCANO_TOKEN: '你的TOKEN',
        VOLCANO_RESOURCE_ID: 'seed-tts-2.0',
        VOLCANO_VOICE: 'zh_female_vv_uranus_bigtts',
        // 企业微信 Bot（可选）
        WECOM_BOT_ID: 'your_bot_id',
        WECOM_BOT_SECRET: 'your_bot_secret',
      },
    },
  ],
};
```

> **重要**：`pm2 restart --update-env` 不会重新读取 ecosystem.config.cjs 的 env。每次改环境变量需要：
> ```bash
> pm2 delete hopcode-ui && pm2 start ecosystem.config.cjs --only hopcode-ui
> ```

### 4.2 .env 文件（可选）

Bun 会自动加载 `.env`，但核心配置在 ecosystem.config.cjs 更稳定：

```bash
cd /home/hopcode/hopcode
sudo -u hopcode /home/hopcode/.bun/bin/bun run src/server-node.ts
# 访问 http://localhost:3000 测试
```

### 4.3 users.json（多用户配置）

```bash
# 创建管理员用户（jack，linuxUser: jack）
sudo -u hopcode cat > /home/hopcode/hopcode/users.json << 'EOF'
{
  "jack": { "password": "你的密码", "linuxUser": "jack" }
}
EOF
chmod 600 /home/hopcode/hopcode/users.json
```

### 4.4 Nginx 配置

```bash
sudo nano /etc/nginx/sites-available/hopcode
```

```nginx
server {
    server_name 你的域名.com;

    location /ai/ {
        proxy_pass http://127.0.0.1:3000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location /serve/ {
        proxy_pass http://127.0.0.1:3000/serve/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
    }

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/你的域名.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/你的域名.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    if ($host = 你的域名.com) {
        return 301 https://$host$request_uri;
    }
    listen 80;
    server_name 你的域名.com;
    return 404;
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/hopcode /etc/nginx/sites-enabled/hopcode
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 4.5 HTTPS 证书

```bash
sudo certbot --nginx -d 你的域名.com --non-interactive \
  --agree-tos --register-unsafely-without-email
```

---

## 5. 启动服务

### 5.1 以 hopcode 用户启动 PM2

```bash
sudo -u hopcode bash -c \
  'export HOME=/home/hopcode && \
   export PATH=/home/hopcode/.bun/bin:$PATH && \
   pm2 start /home/hopcode/hopcode/ecosystem.config.cjs'
```

### 5.2 保存 PM2 配置（开机自启）

```bash
sudo -u hopcode bash -c \
  'export HOME=/home/hopcode && \
   export PATH=/home/hopcode/.bun/bin:$PATH && \
   pm2 save'
```

### 5.3 常用管理命令

```bash
# 查看状态
sudo -u hopcode bash -c 'export HOME=/home/hopcode PATH=/home/hopcode/.bun/bin:$PATH pm2 list'

# 查看日志
sudo -u hopcode bash -c 'export HOME=/home/hopcode PATH=/home/hopcode/.bun/bin:$PATH pm2 logs --lines 50'

# 重启
sudo -u hopcode bash -c 'export HOME=/home/hopcode PATH=/home/hopcode/.bun/bin:$PATH pm2 restart all'

# 只重启 UI
sudo -u hopcode bash -c 'export HOME=/home/hopcode PATH=/home/hopcode/.bun/bin:$PATH pm2 restart hopcode-ui'
```

---

## 6. 防火墙配置（UFW）

```bash
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# sudo ufw allow 3000/tcp  # 如果不用 nginx 直接暴露
sudo ufw enable
sudo ufw status
```

---

## 7. 代码修改说明（与上游的差异）

pull 新代码后以下修改需要保留（可通过 patch 或手动应用）：

| 文件 | 修改内容 | 严重性 |
|------|---------|--------|
| `src/server-node.ts` | URL 路径 `/terminal` → `/ai` | 高 |
| `src/server-node.ts` | Easy→Pro 切换去掉自动启动 claude | 中 |
| `src/server-node.ts` | 创建用户时自动写 sudoers | 高 |
| `src/server-node.ts` | 创建用户时设置 coding 目录权限 | 高 |
| `src/server-node.ts` | 上传文件存到 `<projectDir>/uploads/` | 中 |
| `src/server-node.ts` | uploads/ 定时清理（>24h） | 低 |
| `src/pty-service.ts` | fork worker 去掉 `execArgv: ['--import', 'tsx']` | 高 |
| `src/easymode/claude-process.ts` | bootstrap claude home 时 sudo fallback | 中 |

---

## 8. 新增用户流程（Admin UI）

通过网页 Admin UI（`/admin`）创建用户时，代码会自动处理：

1. 创建 linux 系统用户
2. 设置 `users.json` 条目
3. 写 sudoers 文件（`hopcode ALL=(newUser) NOPASSWD: ALL`）
4. 设置 coding 目录权限

**但以下需要手动确认：**

```bash
# 如果 Admin UI 创建后用户无法登录，检查：
# 1. linux 用户是否创建成功
getent passwd alice

# 2. coding 目录权限
ls -la /home/alice/coding

# 3. claude-hopcode 目录
ls -la /home/alice/.claude-hopcode/.claude/

# 4. sudoers 文件
cat /etc/sudoers.d/hopcode-alice
```

---

## 9. 已知问题（Lima02 特殊）

### 9.1 CSP unsafe-eval 阻止 Easy Mode 运行

**问题**：浏览器 Console 报错 `Content Security Policy blocks use of 'eval'`，导致 Easy Mode 的 Claude Code 无法初始化。

**原因**：Caddy 配置的 CSP header 中缺少 `'unsafe-eval'`。

**修复**：在 `src/server-node.ts` 的 CSP header 字符串中加入 `'unsafe-eval'`（约第 11501 行）：
```typescript
res.setHeader('Content-Security-Policy',
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; ...");
```

**验证**：`curl -sI https://lima.gizwitsapi.com/terminal/easy | grep content-security-policy`

### 9.2 ServiceWorker 缓存旧 JS 导致功能异常

**问题**：浏览器（即使无痕）ServiceWorker 缓存了旧 JS 代码，导致新建项目等功能点击无反应。

**原因**：`public/sw.js` 中 `CACHE = 'hopcode-v3'` 缓存了旧的 HTML 响应。

**修复**：
1. 把 `public/sw.js` 中 `CACHE = 'hopcode-v3'` 改为 `hopcode-v4`
2. 重启 hopcode-ui
3. 用户需在 DevTools → Application → Service Workers → Unregister 旧 SW，或完全关闭浏览器再打开

**验证**：`curl -s https://lima.gizwitsapi.com/terminal/sw.js | head -1` 应显示 `hopcode-v4`

### 9.3 新建项目后 spinner 不停

**问题**：点击"新建项目"，modal 关闭后 spinner 转 3 秒，页面无变化。

**原因**：`createProject` 成功后调用 `switchProject(name)` 跳转到 portal 页面（`/terminal/easy`，无 session 参数），导致项目列表为空，看起来像"没反应"。

**修复**（`src/server-node.ts`，`createProject` 函数）：
```typescript
// 旧代码（有问题）：
fetch(url, { method: 'POST' })
  .then(function() { switchProject(name); })  // switchProject 跳转到无 session 的 portal

// 新代码（正确）：
fetch(url, { method: 'POST', signal: AbortSignal.timeout(10000) })
  .then(function(r) {
    console.log('[createProject] mkdir response:', r.status, r.statusText);
    // 直接导航到当前 session + 新项目，不经过 portal
    location.href = '/terminal/easy?session=' + encodeURIComponent(curSession) + '&project=' + encodeURIComponent(name);
  })
  .catch(function(err) {
    console.error('[createProject] mkdir error:', err.message);
    location.href = '/terminal/easy?session=' + encodeURIComponent(curSession) + '&project=' + encodeURIComponent(name);
  });
```

同时 `curSession` 需从 URL 参数获取（因为 `sessionId` 在 IIFE 作用域内可能为空）：
```typescript
var curSession = new URLSearchParams(location.search).get('session') || sessionId || '';
```

### 9.4 Lima02 代码路径

Lima02 上代码在 `/home/hopcode/hopcode/`（不是 `/home/jack/coding/voice-terminal/`）。

服务运行：
- `hopcode-ui`：`/home/hopcode/.bun/bin/bun /home/hopcode/hopcode/src/server-node.ts`
- PM2 路径：`/home/hopcode/.bun/bin/pm2`

重启：
```bash
ssh jack@lima02 "sudo -u hopcode /home/hopcode/.bun/bin/pm2 restart hopcode-ui"
```

同步本地代码到 Lima02：
```bash
# 同步 server-node.ts
scp src/server-node.ts jack@lima02:/tmp/server-node.ts
ssh jack@lima02 "sudo -u hopcode tee /home/hopcode/hopcode/src/server-node.ts" < /tmp/server-node.ts

# 同步 sw.js
scp public/sw.js jack@lima02:/tmp/sw.js
ssh jack@lima02 "sudo -u hopcode tee /home/hopcode/hopcode/public/sw.js" < /tmp/sw.js
```

### 9.5 Caddy 路径重写注意

Lima02 用 Caddy 作为反向代理。关键注意点：

- `handle /terminal { redir /terminal/ 302 }` — **不要**在 `handle` 块内用 `redir`，会导致 Location header 被解析为 "302" 字符串
- 应该用 **top-level** `redir /terminal /terminal/ 302`
- `handle_path /terminal/*` 会自动 strip 前缀再转发给后端，不要再用 `uri strip_prefix`

---

## 10. 常见问题排查

### Q: pm2 找不到 bun
**A**: 用绝对路径。PM2 环境变量不继承 login shell：
```bash
sudo -u hopcode bash -c 'export HOME=/home/hopcode PATH=/home/hopcode/.bun/bin:$PATH pm2 list'
```

### Q: PTY service 启动后立即退出
**A**: 检查是否用了 Bun 而不是 Node.js。start-pty.sh 必须用 `npx tsx`（Node.js）。

### Q: 登录 401 Unauthorized
**A**: `hopcode-pty` 和 `hopcode-ui` 的 `AUTH_PASSWORD` 必须完全一致。

### Q: Easy Mode claude 以 hopcode 用户运行而不是目标用户
**A**: 检查 `/home/<user>/.claude-hopcode` 目录是否存在且 hopcode 组可写。

### Q: 预览文件 404
**A**: Nginx 必须有 `location /serve/` 代理规则。

### Q: bun: command not found
**A**: Bun 没加到 PATH。每次运行 pm2 命令都要指定完整路径或先 `source ~/.bashrc`。

### Q: 企业微信 Bot 连接失败
**A**: 检查 WECOM_BOT_ID 和 WECOM_BOT_SECRET 是否正确，网络能否访问 `wss://openws.work.weixin.qq.com`。

### Q: 语音功能不工作
**A**: 确认 VOLCANO_APP_ID 和 VOLCANO_TOKEN 有效，且服务器能访问 `openspeech.bytedance.com`。

### Q: 端口 3000 被占用
**A**: `sudo lsof -i :3000` 或 `sudo netstat -tlnp | grep 3000` 查占用进程。

---

## 11. 快速检查清单

部署完成后逐一确认：

```
□ pm2 list 显示 hopcode-pty 和 hopcode-ui 都是 online
□ curl http://localhost:3000 返回 HTML 页面
□ https://你的域名.com/ai/ 可访问（nginx 正常）
□ 登录页输入正确密码可进入
□ 新建项目后 claude 正常响应
□ pm2 save 已执行（重启后自动恢复）
□ 防火墙已配置（ufw status）
```
