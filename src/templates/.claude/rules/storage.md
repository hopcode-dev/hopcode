# 数据存储选型

## 决策树

**问题1：同事之间需要看到彼此的数据吗？**
- 否（个人工具）→ localStorage
- 是（需要共享）→ 继续

**问题2：多少人用？**
- 100人内 → JSON 文件
- 100人+ → SQLite

## JSON 文件规范（100人内）

```javascript
// 两个函数，不缓存、不建索引、不做内存状态
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

**规则：**
- 每次 save/findAll 直接读写文件，不用 Map 缓存
- 100用户时差异不可感知，无需优化
- 文件名用项目名：`users.json`、`tasks.json`

## SQLite 升级（100人+）

当用户突破100人时迁移：
1. 用 `better-sqlite3` 替代 JSON
2. 建表与 JSON keys 对应
3. 一次性脚本导入旧数据

数据结构不变，迁移简单。

## 选型话术

> 你的工具主要谁用？
> - 只有我一个人 → localStorage够了
> - 团队几个人要看到彼此数据（100人内）→ JSON文件，简单够用
> - 100人以上 → 建议用SQLite，功能一样，性能更好
