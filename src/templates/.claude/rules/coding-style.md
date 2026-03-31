# 编程禁区 & 调试规范

## 禁区（⚠️ 导致死循环/卡死的写法）

### 1. 禁止 while(true) 类循环
```javascript
// ❌ 死循环
while (true) { ... }

// ✅ 用 for 限制迭代次数
for (let i = 0; i < maxIterations; i++) { ... }

// ✅ 或递归 + 深度限制
function recurse(depth) {
  if (depth > maxDepth) return;
}
```

### 2. 禁止猜测文件路径
```javascript
// ❌ 小码经常猜错
import { foo } from '/home/user/project/src/utils';

// ✅ 用相对路径
import { foo } from './utils.js';
```

### 3. 禁止猜测 npm 包存在
```javascript
// ❌ 假设某包已安装
import { foo } from 'some-package';

// ✅ 先 grep 确认 node_modules 中存在
```

### 4. 禁止 innerHTML 插入用户输入
```javascript
// ❌ XSS 风险
element.innerHTML = userInput;

// ✅ 用 textContent
element.textContent = userInput;
```

## 调试规范（改 Bug）

### TDD 最小闭环
1. 写一个测试，复现 Bug
2. 运行测试确认失败
3. 修 bug
4. 运行测试确认通过

```javascript
test('添加任务应该成功', () => {
  const tasks = [];
  addTask(tasks, { title: '测试' });
  expect(tasks.length).toBe(1);
});
```

### Playwright 调试 SOP
1. `playwright_navigate` 打开问题页面
2. `playwright_click` / `playwright_fill` 复现步骤
3. `playwright_console_logs` 查报错
4. `playwright_screenshot` 确认界面状态
5. 修复后重新执行步骤验证

## 过度设计禁区

- 100人内不需要：Redis、数据库连接池、ORM
- 简单CRUD不需要：设计模式、抽象工厂
- 单文件能搞定：不需要拆分成多个模块
- **先MVP闭环，再考虑扩展**
