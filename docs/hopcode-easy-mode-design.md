# Hopcode Easy Mode Design Doc

## 1. 背景与目标

Hopcode Easy Mode 让非程序员（白领）在企业微信里说话就能做小工具。

**核心价值：小码在云端开发，用户的数据天然在服务器上。**

```
传统开发：本地写代码 → 打包 → 找服务器 → 配置 → 部署 → 给链接
                 ↓
            每一步都要技术能力

小码开发：用户说话 → 小码在云端写代码 → 立刻生成链接 → 用户拿到链接
                 ↓
            小码和服务器在一起，没有"部署"概念
```

**数据天然在服务器 = 多设备天然同步**

```
localStorage：换设备数据就没了
小码的方案：数据在服务器，换手机换电脑都能访问
```

**核心差异化：**
- 开发地点：云端服务器，不是本地机器
- 数据存储：原生在服务器，多设备同步
- 交互方式：说话就行，不需要会编程
- 入口：企业微信，不是浏览器
- 交付：直接给链接，微信里直接用

## 2. 小码开发规范

### 2.1 先想后做原则

遇到问题时的检查清单：

```
1. 先读报错，理解问题在哪一层（nginx？Express？数据库？）
2. 优先应用层解决（server.js），其次才是基础设施（nginx/pm2）
3. 动手前先说："我判断问题在 ___，打算用 ___ 解决"
4. 最小改动：能改一行代码解决，就不动配置文件
5. 不确定时，先在小范围测试
6. 不需要 sudo：能用用户权限解决，就不改权限
```

### 2.2 项目复杂度判断

```
简单（游戏、工具、一次性的）：
  → 直接做，边做边试，不写测试

复杂（管理系统、有数据的）：
  → 先想清楚核心功能
  → 写核心 API 的测试
  → 再做
```

### 2.3 AI-Friendly 项目结构

```
✅ 好：单文件 HTML，自包含
✅ 好：模块少、清晰、独立
❌ 坏：多个大文件相互依赖
❌ 坏：util.js（1000行乱七八糟的工具函数）
```

**规则：尽量做成单个 HTML 文件。多人系统拆成多个独立小工具，不是一个大项目。**

### 2.4 技术选型原则（数据存储）

**核心约束：100 用户内，JSON 文件要能撑住。**

所有架构设计围绕这个目标。

---

**第一个问题：同事之间需要看到彼此的数据吗？**

这是真正的分水岭。

```
不需要看到彼此的数据？
  → 每人一文件，数据隔离，各看各的
  → JSON 文件（per-user 模式）

需要看到共享数据？
  → 共享 JSON 文件模式
  → 每人只读不写，或者写入频率低
```

---

**第二个问题：会不会同时写同一份数据？**

```
不会同时写同一张表？
  → JSON 文件够用

会同时写（比如 3 个人同时填同一张表）？
  → 小码要主动说：这个有点复杂，我们换个做法
  → 方案A：让大家排队，轮流填
  → 方案B：升级到 SQLite（并发安全）
  → 方案C：坦白说这超出小码擅长范围
```

---

**100 用户的 JSON 文件架构：**

```
/data/
  alex.json        # Alex 自己的数据
  betty.json       # Betty 自己的数据
  ...
  shared_signups.json   # 共享签到表（写入频率低）
```

- 每人一文件 → 100 个文件，JSON 读写毫无压力
- 共享文件 → 只有少数人同时写，不会冲突
- 小码不用学数据库 → 直接读写 JS 对象

**什么会突破 100 用户天花板：**

| 场景 | 会不会超 | 原因 |
|------|---------|------|
| 100 人各自看自己的数据 | ✅ 不会 | 每人一文件，互不干扰 |
| 100 人填同一张表 | ⚠️ 危险 | 同时写会冲突 |
| 100 人实时聊天 | ❌ 超 | 需要 WebSocket，JSON 撑不住 |
| 100 人同时编辑同一文档 | ❌ 超 | 需要 OT/CRDT 算法 |

---

**小码选存储的标准话术：**

```
问："这个工具做好后，是你自己用还是给同事一起用？"

→ 只有自己用
  → JSON 文件，存你自己的数据

→ 给同事用
  → "同事之间需要看到彼此填的内容吗？"

    → 不需要，各看各的 → 每人一文件，数据隔离
    → 需要看到共享数据 → 共享 JSON 文件
```

---

**用户说"会有100人以上"怎么办：**

```
小码要告诉用户：

"先找 10-20 个人用起来，确认需求是对的，
 等功能闭环了、大家都在用了，再升级支持更多人。

不要一开始就想着 100 人，这样：
- 开发周期变长
- 复杂度陡增
- 小码出错率上升
- 用户等不到那一天

先跑通 10 人的闭环，比设计 100 人的蓝图更有价值。"
```

**贪心的代价：**

```
100 人系统 ≠ 10 人系统 × 10
它是完全不同的复杂度等级：
- 要考虑并发
- 要考虑权限
- 要考虑数据隔离
- 要考虑性能

MVP 先用 10 个人跑通，确认"有人真的在用"，
再去想 100 人的事。
```

**真的超过 100 人了怎么办：**

```
小码可以告诉用户：

"这个工具我能做，但 100 人以上的系统，
 有点像'我能自己装修房子，但我不会去建一栋写字楼'。

  小码做敏捷开发、快速迭代很强，
  但专业的事情交给专业团队更靠谱。

  你可以先让小码做个 10 人版的 MVP，
  跑通了证明需求是对的，
  再找 IT 同事或者软件公司做完整版。"

或者：

"100 人同时用的系统，就像让一个人去开餐厅而不是做家常菜 —
  我能做，但需要更多时间和精力。
  先让小码做个简化版，证明这个想法有价值。"
```

---

**迁移路径：**

```
JSON 文件 → SQLite → PostgreSQL
     ↓            ↓
  数据保留      数据保留
```

升级时数据都能保留，小码写一次性的迁移脚本就行。

---

**小码数据库规则（必须遵守）：**

```
1. 用户输入绝对不能拼进 SQL（SQL 注入）
   ❌ db.query(`SELECT * WHERE name = '${name}'`)
   ✅ db.query('SELECT * WHERE name = ?', [name])

2. 加字段永远设 DEFAULT
   ❌ ALTER TABLE orders ADD COLUMN status TEXT;
   ✅ ALTER TABLE orders ADD COLUMN status TEXT DEFAULT 'pending';

3. 读数据要做兼容
   const grade = row.grade ?? '普通';  // 旧数据没有 grade 也行

4. 循环里不查数据库（防 N+1）
   ❌ for (const id of ids) { db.query('SELECT * WHERE id = ?', id) }
   ✅ db.query('SELECT * WHERE id IN (?)', [ids])
```

---

**为什么先文件后数据库：**

```
- 交付快（不配环境、不装数据库）
- 出错少（没有 schema 迁移问题）
- 调试易（小码直接看到 JSON 结构）
- 能迭代（路径清晰，用户等得起）

不要一开始就上数据库：
- 配环境耗时间
- 小码要多学 SQL 语法
- schema 改起来麻烦
- 用户等不起
```

---

**JsonDB 标准模板（直接读写文件，最简单的版本）：**

```javascript
// 每次读写直接从磁盘，100 条数据读写一次 1-2ms，没感觉
function save(filename, row) {
  let data = [];
  try { data = JSON.parse(fs.readFileSync(filename, 'utf-8')); } catch {}
  row.id = row.id || Date.now().toString();
  const idx = data.findIndex(r => r.id === row.id);
  if (idx >= 0) data[idx] = row;
  else data.push(row);
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
}

function findAll(filename, query) {
  let data = [];
  try { data = JSON.parse(fs.readFileSync(filename, 'utf-8')); } catch {}
  return data.filter(row =>
    Object.entries(query).every(([k, v]) => row[k] === v)
  );
}
```

不用 class，不用 init，不用维护内存状态。

---

**100 人内的登录实现（极简版）：**

```javascript
// 一个 JSON 文件存用户：users.json
// [{ username: 'alex', password: '简单hash' }]

// 登录 API：内存存 session
const sessions = new Map();

BUN.serve({
  '/api/login': async (req) => {
    const { username, password } = await req.json();
    const users = JSON.parse(fs.readFileSync('users.json', 'utf-8'));
    const user = users.find(u => u.username === username && u.password === password);
    if (!user) return new Response('{"error":"账号或密码错误"}', {
      headers: { 'Content-Type': 'application/json' }
    });
    const token = Math.random().toString(36).slice(2);
    sessions.set(token, username);
    return new Response(JSON.stringify({ token }));
  }
});
```

---

**100 人内的防过度设计清单：**

| 不用做的 | 原因 |
|---------|------|
| 不用 JWT | 简单 cookie session 够了 |
| 不用微服务 | 一个进程跑所有 API |
| 不用 Redis 存 session | 内存 Map 就够了（进程重启才清） |
| 不用负载均衡 | 单台服务器够用 |
| 不用 WebSocket | 轮询 5-10 秒一次够用 |
| 不用消息队列 | 直接处理请求就行 |
| 不用 Docker/K8s | PM2 够用 |

**结论：100 人内 = 单机 + 文件/JSON + 内存 session，不需要任何分布式的东西。**

---

### 2.5 中文开发常见错误

**最容易犯的 3 个（一定要避免）：**

| 错误 | 后果 | 正确写法 |
|------|------|---------|
| 没写 `<meta charset="UTF-8">` | 页面中文全乱码 | `<meta charset="UTF-8">` 永远要写 |
| URL 带中文不编码 | 404 | `encodeURIComponent()` |
| 文件名用中文 | 部署到 Linux 出问题 | 用英文文件名 |

**其他常见错误：**

```
1. 读文件忘指定编码
   ❌ fs.readFileSync('data.json')
   ✅ fs.readFileSync('data.json', 'utf-8')

2. 正则里忘了匹配中文
   ❌ /[a-zA-Z]/  // 只匹配英文
   ✅ /[\u4e00-\u9fa5]/  // 匹配中文

3. fetch 带中文不编码
   ❌ fetch('/api/search?name=' + name)
   ✅ fetch('/api/search?name=' + encodeURIComponent(name))

4. JSON 里中文完全正常，不用特殊处理
   ✅ const data = { name: '张三', city: '深圳' };  // 正常
```

**自检清单：**

```
□ HTML 开头有没有 <meta charset="UTF-8">
□ URL 里出现中文有没有 encodeURIComponent()
□ 文件名是不是英文的
□ fs.readFileSync 有没有加 'utf-8'
```

## 3. 部署流程规范

### 3.0 发布方式选择：/serve/ 还是 nginx 反向代理

**两种方式的区别：**

| 方式 | URL 样子 | API 支持 | 适用场景 |
|------|---------|---------|---------|
| `/serve/` | `gotong.gizwitsapi.com/serve/session-id/workspace/` | ❌ 只 serving 静态文件 | 纯前端页面 |
| nginx 反向代理 | `gotong.gizwitsapi.com/alex/xxx/` | ✅ 可以代理到后端服务 | 有 API 的应用 |

**用 `/serve/ 就够了的情况（纯前端）：**

```
- 表单收集、数据展示、工具类页面
- 不需要用户登录
- 数据存在浏览器（localStorage）或不上服务器
- 快速验证，不确定长期用不用
```

**需要 nginx 反向代理的情况（有后端）：**

```
- 需要用户登录注册（服务端 session）
- 数据要存在服务器（不是浏览器 localStorage）
- 有 /api/xxx 等后端接口
- 要对接第三方 API（服务器端转发）
```

**前端/后端分离的边界（小码自己判断）：**

```
问自己：这个工具需要什么？

→ 需要用户登录？ → 分离，后端
→ 需要在服务器存数据？ → 分离，后端
→ 需要调用第三方 API？ → 分离，后端
→ 都不需要？ → 单 HTML 够了，不分离
```

**小码话术：**

```
"这个工具先给你一个临时链接看着：
{{SERVE_URL}}xxx.html

如果确定要长期用，或者需要登录、数据存服务器，
我帮你注册一个固定链接。"
```

### 3.1 部署前检查清单

```
□ 端口是否可用（PM2 list 里有无冲突）
□ 文件是否在正确位置
□ 代码有没有明显语法错误
□ 权限是否足够
```

### 3.2 部署后自动验证

```
1. curl 检查关键路径返回 200
2. curl 模拟一次核心操作（如 POST 表单）
3. 检查 PM2 日志有没有 Error
4. 如果有问题 → 自动修 → 重检
5. 多次失败 → 通知技术人员，保留现场
```

### 3.3 完成后交付规范

```
"好了！你试试这个链接能不能用：
{{LIVE_URL}}}xxx.html

如果有任何问题，截图给我，我立刻修。
数据安全的，放心。"
```

**小码必须等用户确认能用才离开。**

## 4. API 设计规范（curl UAT 友好）

### 4.1 路径设计

```
✅ GET 请求路径自带参数：
   GET /api/customers/123

❌ 不要用 query string：
   GET /api/customers?id=123  （curl 里难写）
```

### 4.2 响应格式

```
✅ 所有响应都是 JSON + HTTP 状态码：
   200 { data: [...] }
   404 { error: "客户不存在" }
   400 { error: "参数错误" }

❌ 不要用：
   200 + error: true  （curl 不知道失败了）
```

### 4.3 不依赖特殊 Header

```
✅ Bearer Token 可以用 query param 代替
✅ OPTIONS 不要限制
❌ 不要限制特定 CORS 域名
```

### 4.4 Body 格式

```
✅ 用 JSON
❌ 不要用 FormData
```

## 5. 缓存最佳实践

### 5.1 规则

```
HTML 文件：不缓存（用户刷新看到最新）
CSS/JS/图片：长缓存（1年），但文件名带 ?v=时间戳
```

### 5.2 时间戳格式

```
✅ 用精确到秒的时间戳：
   ?v=20260329162839

这样同一天多次部署也能区分
```

### 5.3 小码自动执行

```
部署后，自动在 HTML 里给所有外部资源加时间戳参数：
<link href="style.css?v=20260329162839">
<script src="app.js?v=20260329162839">
```

## 6. 代码安全规范（Escaping 禁区）

### 6.1 问题根源

HTML 解析器在 `<script>` 标签里看到 `</` 时会提前关闭标签，即使它在字符串里也一样。

```
❌ 小码写的代码：
<script>
  var html = '<a onclick="fn()">click</a>';
  element.innerHTML = html;
</script>

❌ HTML 解析器看到 </a> 以为 script 结束了
```

### 6.2 禁区模式（不要写）

```
❌ 正则表达式里出现字面的 </：
   /<\//g   →  HTML 解析器提前关闭 <script>
   str.replace(/</g, '&lt;')  → 同上

❌ 在 innerHTML 里插入用户输入：
   element.innerHTML = userInput  → XSS 风险

❌ 字符串拼接包含 HTML 标签的用户内容：
   '<div>' + userName + '</div>'  → 同上
```

### 6.3 安全写法

```
✅ 用 textContent 代替 innerHTML 插入纯文本：
   element.textContent = userInput

✅ 替换字面的 < 字符：
   /\x3c/g  代替 /</  (正则)
   str.replace(/\x3c/g, '&lt;')  (字符串)

✅ 插入 HTML 标签时确保不包含用户输入：
   用 DOM API：document.createElement() + appendChild
```

### 6.4 自检清单

小码生成 HTML 后检查：

```
□ <script> 块里有没有字面的 </ 字符？
□ innerHTML 赋值是否涉及用户输入？
□ 涉及用户输入的地方是否用了 textContent？
```

### 6.5 遇到 escaping 报错怎么办

```
→ 查本节禁区列表
→ 修 + 更新 design doc
→ 常见错误：Unexpected token '</' 或 "was not closed"
```

## 7. 错误处理与用户反馈

### 7.1 问题上报机制

**目标：用户不需要开 DevTools，小码直接知道哪里坏了**

```
页面角落加"🆘 有问题"按钮（点击3下出现，或固定显示）
    ↓
用户点击 → 弹出问题描述表单
    ↓
用户填写 → 内容发到小码对话
    ↓
小码直接看到问题截图/描述 → 修
```

### 7.2 Playwright 自动复现

**价值：用户描述不清时，小码自己看**

```
用户报 bug → 小码用 Playwright 在服务器端跑一遍
    ↓
截图 + 控制台日志 + 网络请求全部拿到
    ↓
小码看到和用户一样的错误 → 精准修复
```

**实现示例：**

```javascript
const { chromium } = require('playwright');

async function reproduceBug(url, steps) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 捕获控制台
  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push({ type: msg.type(), text: msg.text() }));

  // 捕获网络错误
  const failedRequests = [];
  page.on('requestfailed', req => failedRequests.push({ url: req.url(), failure: req.failure()?.errorText }));

  await page.goto(url);

  // 重放用户操作（steps 是用户描述的点击/输入序列）
  for (const step of steps) {
    if (step.type === 'click') await page.click(step.selector);
    if (step.type === 'input') await page.fill(step.selector, step.value);
  }

  // 截图
  await page.screenshot({ path: 'bug-repro.png', fullPage: true });

  // 输出诊断信息
  console.log('Console errors:', consoleLogs.filter(l => l.type === 'error'));
  console.log('Failed requests:', failedRequests);

  await browser.close();
}
```

**何时用：**
- 用户描述模糊，但错误可复现
- 不需要用户开 DevTools
- 小码自己看到问题，省去来回截图

**注意：** 这不是自动化测试，是调试工具。普通 bug 不需要，只有复现困难时才用。

### 7.3 用户安抚话术

```
遇到问题 → 小码说：
"别担心，这类问题很常见，我来解决。
 你的工具不受影响，数据安全的。
 我会一直在这里，搞定为止。"
```

### 7.4 技术实现

```javascript
// 全局捕获错误（不显示浏览器默认报错）
window.onerror = (msg, url, line, col, err) => {
  fetch('/api/report-error', {
    method: 'POST',
    body: JSON.stringify({
      msg: String(msg),
      url: location.href,
      line,
      col,
      stack: err?.stack,
      userAgent: navigator.userAgent,
      time: new Date().toISOString(),
    })
  });
  return true;
};

// 页面角落显示一个小按钮
// "🆘 有问题？" → 点开 → 填描述 → 发给小码
```

### 7.5 Playwright MCP（自动复现 Bug）

**价值：用户描述不清时，小码自己在浏览器里跑一遍。**

用户报 bug → 小码用 Playwright 复现 → 截图 + 日志全部拿到 → 精准修复。

**MCP 工具清单（业界标准）：**

| 工具 | 作用 |
|------|------|
| `navigate` | 打开 URL |
| `click` | 点击元素 |
| `fill` | 填写输入框 |
| `extract_text` | 查询 DOM 内容（验证页面显示） |
| `screenshot` | 截图 |
| `console_logs` | 控制台日志 |
| `network_errors` | 失败的请求 |

**小码调用 SOP：**

```
1. playwright_navigate(url) → 打开页面
2. playwright_screenshot() → 先看页面长什么样
3. playwright_click(selector) × N → 重现用户操作
4. playwright_console_logs() → 抓错误
5. playwright_extract_text(selector) → 验证页面内容
```

**MCP server 关键实现：**

```typescript
// 1. 浏览器实例只启动一次，复用整个 session
let browser: Browser | null = null;
let page: Page | null = null;

async function init() {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  // 监听器只设一次，累积日志
  page.on('console', msg => consoleLogs.push({ type: msg.type(), text: msg.text() }));
  page.on('requestfailed', req => networkErrors.push(req.url()));
}

// 2. console_logs 取走并清空，避免日志膨胀
console_logs: async () => {
  const logs = consoleLogs.splice(0);
  consoleLogs.length = 0;
  return logs;
}
```

**什么时候用：**
- 用户描述模糊，但错误可复现
- 不需要用户开 DevTools
- 小码自己看到问题，省去来回截图

**注意：** 这不是自动化测试，是调试工具。普通 bug 不需要，只有复现困难时才用。

## 8. TDD 落地规范

**核心理念：改 bug 时测试先行，减少用户困惑。**

用户不是程序员，给 bug 描述不清楚；小码修一个 bug 来来回回很耗时。测试先写 = 减少返工 = 用户少困惑。

### 8.1 改 bug 时的 TDD 最小闭环

```
用户报 bug → 小码先写一个测试复现 bug → 测试失败
    ↓
小码修代码
    ↓
测试通过 = bug 修好了
```

**改 bug TDD 流程：**

```
1. 用户报 bug → 先写测试（描述用户怎么操作的）
2. 运行测试 → 确认测试失败（复现 bug）
3. 小码修代码
4. 运行测试 → 确认测试通过
5. 交付
```

**测试怎么写（最简单）：**

```javascript
test('用户输入中文名字，搜索结果正确', async () => {
  const res = await fetch('/api/search?name=张三');
  const data = await res.json();
  expect(data.results.length).toBeGreaterThan(0);
});
```

### 8.2 什么时候不用写测试

```
- 改文字/样式 → 不需要测试
- 改一个明显不会影响其他功能的地方 → 不需要
- 只有用户在用的简单工具 → 不需要
```

### 8.3 复杂系统才做完整 TDD

| 项目类型 | 怎么做 |
|---------|--------|
| 贪吃蛇、计算器 | 不需要 |
| 客户管理、订单系统 | 核心逻辑写测试 |
| 多人协作、支付 | 需要完整 TDD |

**一句话：改 bug 时测试先行，其他时候不做强制要求。**

## 9. 多文件项目处理

### 9.1 现状

```
LLM 上下文窗口有限
文件越多，依赖越深，AI 越容易出错
```

### 9.2 解决思路

```
1. Context Engineering：精准给上下文，不要给无关文件
2. AI-Friendly Codebase：结构清晰，单一职责
3. 复杂项目拆分：多个小工具，不是大系统
```

### 9.3 server.js 什么时候拆

**不应该拆的情况（LLM 能 hold 住）：**

```
- 500 行以内
- 所有路由都在一个文件里
- 只有一个数据源（JSON 或 SQLite）
```

**应该拆的情况：**

```
1. server.js 超过 1000 行
   → LLM 开始容易"忘了"另一个文件的代码

2. 路由和处理逻辑明显是两类功能
   → /routes/ → 路由定义（GET /api/xxx, POST /api/yyy）
   → /services/ → 业务逻辑（怎么查数据库、怎么处理数据）

3. 有两个及以上的数据源
   → 比如同时用 JSON 文件和 SQLite
```

**拆分方式（最简单的多文件架构）：**

```
project/
├── server.js       ← 入口，路由定义
├── routes/
│   ├── auth.js     ← 登录相关
│   └── data.js     ← 数据操作相关
├── services/
│   └── db.js       ← JSON 文件读写封装
└── workspace/      ← 前端 HTML
```

**判断标准：**

```
小码问自己：server.js 是不是超过 1000 行了？

→ 没超过 → 不拆，继续写
→ 超过了 → 拆成 routes/ + services/

不要过早拆分！1000 行是拆分信号，不是 200 行。
过早拆会让 LLM 上下文碎片化。
```

### 9.4 参考：KiloCode 的做法

```
AGENTS.md：项目级 Prompt，每次启动读取
Snapshot 系统：精确回滚单个文件，不污染用户 git
Multi-Agent：Architect/Coder/Debugger 分工
Spec-Driven：先写规格，用户确认后再实现
```

## 10. AI 调试卡住常见模式

### 10.1 小码自己怎么避免

```
改完先跑一遍，确认不报错再交付。
跑不通立刻停，换思路，不要重复试同一个方法。
```

**6 个最常见的卡住原因：**

| 模式 | 描述 | 解决 |
|------|------|------|
| 无限循环改错 | 改 A 出 B，改 B 出 A，循环往复 | 停下来，重新分析根因 |
| 路径乱飞 | 不确定文件在哪，创建新文件而不是编辑现有 | `ls` 确认文件存在再改 |
| 依赖幻觉 | 以为某个包/模块存在，实际没有 | 先 `npm list` 或 `ls node_modules/` 确认 |
| 改丢用户代码 | 改着改着把用户原有代码覆盖了 | 修改前先确认当前文件内容 |
| 权限幻觉 | 以为能 sudo 能写，实际没有权限 | 用 `ls -la` 确认权限 |
| 路径基准错 | 不知道当前工作目录，导致 import 404 | 每次操作前 `pwd` 确认 |

### 10.2 怎么判断自己卡住了

```
连续 3 次尝试同一件事 → 换思路
同一错误出现 2 次 → 停下来查根因
不知道错误原因就动手 → 先分析再改
```

### 10.3 换思路的方法

```
换工具：手动 curl 测试，而不是只靠 AI
换角度：这个错误是哪个函数引起的？
缩小范围：注释掉一半代码，二分查找
查文档：而不是重复尝试
```

### 10.4 小码调试守则

```
1. 报错出来先理解，不急着改
2. 改一行能解决的不动三行
3. 改完立刻验证（curl / 运行 / 看日志）
4. 验证通过再交付
5. 交付后问用户"能用了吗"，确认才离开
```

## 11. 小码能力边界（用户期望值）

**目标：用户知道什么可以交给小码，什么需要找真人。**

### 11.1 擅长的事情 ✅

```
小码做这些又快又好：
- 单个页面工具（计算器、登记表、问卷）
- 游戏（贪吃蛇、打砖块、五子棋）
- 数据图表（输入数据，生成图表）
- 网页工具（待办、记事本、倒计时）
- 修复明显报错（页面打不开、点不动）
- 改样式和文字
- 导出数据（生成 Excel/CSV）
```

### 11.2 容易碰壁的事情 ⚠️

```
这些场景，小码容易卡住或做不好：
- 需要登录注册系统（涉及数据库、权限、安全）
- 需要连接外部 API（第三方接口可能变）
- 需要手机验证码、微信支付等对接
- 需要多人同时操作（实时协作）
- 需要处理很大量的数据（性能问题）
- 需要设计复杂流程（超过 3-4 个步骤）
- 需要对接公司内部系统
```

### 11.3 碰壁信号（用户能看到）

```
如果小码出现以下情况，就是遇到困难了：
- 说"这个比较复杂，需要想想"
- 同一个问题说了 3 次还没修好
- 说"需要你提供更多信息"超过 2 次
- 告诉你需要找技术人员
```

### 11.4 碰壁了怎么办

```
用户可以说：
"这个问题有点难，换个思路可以吗？"
"能不能先做个简单版能用？"
"这个功能暂时不要了，换别的"

小码遇到困难时应该主动说：
"这个功能涉及到XXX，超出了我的擅长范围，
 有几个方案你想试试吗：
 A. 简化成XXX（简单但功能少）
 B. 我做一个最基本版能用，你找技术同事补充
 C. 先不做这个，跳过"
```

### 11.5 边界原则

```
能用 1 个 HTML 文件解决的 → 小码擅长
需要数据库 + 后端 + 登录的 → 超出擅长范围
超过 500 行代码的改动 → 容易出错
涉及钱/支付/权限的 → 需要专业人员
```

## 12. 待讨论问题（已有答案）

### 12.1 用户报错按钮的产品形态

```
→ 固定显示，但要小、要柔和

非技术用户不会主动找隐藏功能，
但显眼的大按钮会让人觉得"这东西很容易坏"。

方案：右下角一个小小的"？"图标，
     点开是"🆘 有问题？点我反馈"
     颜色不要太警告色，用灰色或蓝色
```

### 12.2 报错信息怎么传到小码

```
→ Webhook 到企微机器人

现有 wecom-bridge 已能发消息，直接复用：
用户点"有问题" → 发一条消息到小码的 WeCom 会话

消息里带上：页面 URL、错误描述、时间、截图（如果用户授权）
```

### 12.3 多文件项目的边界

```
→ 前端尽量单 HTML，后端最多 1 个 server.js

"复杂"的标准：
- 前端超过 1 个 HTML 文件 → 考虑拆成独立工具
- 前端需要 import 超过 3 个 JS/CSS → 考虑合并
- 有 util.js 这种工具大杂烩 → 拆分
- 后端超过 1 个 server.js 文件 → 考虑合并或拆分模块

一句话：能用 1 个 HTML 解决的就不拆，
      backend 最多 1 个文件 + workspace/ 下的静态文件
```

### 12.4 TDD 在 Hopcode 的落地节奏

```
→ 现在不推，先跑 MVP

原因：
- 小码写测试本身就需要学习
- 用户不懂测试，不会给小码写测试的指令
- 简单工具（游戏、表格）不需要测试

时机：当小码开始做"客户管理、订单系统"这类复杂系统时，
     小码自己判断，主动建议"这个项目应该先写测试"

起步：只对复杂系统推 TDD，简单工具不做要求
```

## 13. 云部署 MCP（未来扩展）

### 13.1 背景

用户想把 app 部署到自己的阿里云、AWS、腾讯云。小码有 Bash 权限，理论上可以 SSH 进去部署，但：
- 凭证管理复杂（存密码有安全风险）
- 云控制台操作还是要用户自己做（配安全组、域名解析等）

更好的方案：做云厂商 MCP，封装云厂商 API。

### 13.2 阿里云 MCP

```typescript
const tools = [
  'ecs_create_instance',      // 创建 ECS 实例
  'ecs_start',                // 启动实例
  'ecs_stop',                // 停止实例
  'oss_upload',              // 上传文件到 OSS
  'security_group_add_rule',  // 添加安全组规则（开端口）
  'dns_add_record',           // 添加 DNS 解析记录
  'ssl_apply',               // 申请 SSL 证书
  'nginx_config',             // 生成 nginx 配置
];
```

### 13.3 AWS MCP

```typescript
const tools = [
  'ec2_create_instance',      // 创建 EC2 实例
  'ec2_start',                // 启动实例
  'ec2_stop',                 // 停止实例
  's3_upload',                // 上传文件到 S3
  'security_group_add_rule',   // 添加安全组规则
  'route53_add_record',       // 添加 DNS 记录
  'acm_request_cert',         // 申请 SSL 证书
];
```

### 13.4 腾讯云 MCP

```typescript
const tools = [
  'cvm_create_instance',      // 创建 CVM 实例
  'cvm_start',                 // 启动实例
  'cvm_stop',                  // 停止实例
  'cos_upload',                 // 上传文件到 COS
  'security_group_add_rule',   // 添加安全组规则
  'dnspod_add_record',         // 添加 DNS 记录
  'ssl_apply',                 // 申请 SSL 证书
];
```

### 13.5 小码调用方式

```
用户："帮我部署到阿里云"
    ↓
小码问用户要 Access Key（只存临时 token，不存明文密钥）
    ↓
小码：aliyun_ecs_create_instance(image: 'Ubuntu 20.04', region: 'cn-hangzhou')
    ↓
小码：aliyun_oss_upload_files(localPath: './workspace', ossPath: '/myapp/')
    ↓
小码：aliyun_security_group_add_rule(port: 80)
    ↓
小码：aliyun_dns_add_record(domain: 'myapp.com')
    ↓
小码：aliyun_ssl_apply(domain: 'myapp.com')
    ↓
完成，给用户链接
```

### 13.6 安全方案

```
核心问题：Access Key = 最高权限凭证，不能存明文

方案1：用户每次手动授权
→ 用户登录云控制台，手动授权
→ 小码拿到临时 token，过期自动失效

方案2：MCP 操作打包
→ 部署 + 权限打包成一个操作
→ 小码执行完就失效，不留凭证

方案3：用户自己管 Access Key
→ 小码不存储，每次让用户输入
→ 用户自己承担泄露风险

推荐：方案1或方案2
```

### 13.7 落地优先级

```
1. 先做阿里云 MCP（国内用户最多）
2. 再做腾讯云 MCP
3. AWS MCP（海外用户）
```
