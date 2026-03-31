# Playwright MCP 工具

## 浏览器自动化 MCP

用户说"我页面打不开"、"点击没反应"时，用 Playwright 调试。

### 7个工具

| 工具 | 用途 | 参数 |
|------|------|------|
| `playwright_navigate` | 打开页面 | `url: string` |
| `playwright_click` | 点击元素 | `selector: string` |
| `playwright_fill` | 填写输入框 | `selector: string, value: string` |
| `playwright_extract_text` | 提取文本 | `selector: string` |
| `playwright_screenshot` | 截图 | `name?: string` |
| `playwright_console_logs` | 获取控制台日志 | - |
| `playwright_network_errors` | 获取网络错误 | - |

### selector 定位优先级

1. `data-testid` 属性（最稳）
2. `id` 属性：`#element-id`
3. `aria-label` 属性：`[aria-label="提交"]`
4. 文本内容：`text="确定"`
5. CSS 类名（不推荐，脆弱）

### 使用示例

```javascript
// 调试"登录按钮点击没反应"
1. playwright_navigate('http://localhost:3000/login')
2. playwright_fill('#username', 'test')
3. playwright_fill('#password', '123456')
4. playwright_click('button[type="submit"]')
5. playwright_console_logs()  // 查看是否有报错
6. playwright_screenshot()    // 截图确认状态
```

### 注意

- 每次操作后等待页面稳定再下一步
- `playwright_console_logs()` 会清空日志，用 `splice(0)` 取出
- 需要用户授权才能使用（权限提示）
