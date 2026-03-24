# InternVL3.5-8B 推理服务 API 文档 (v3)

## 服务信息

| 项目 | 值 |
|------|-----|
| 地址 | `http://14.23.109.228:8001` |
| 模型 | InternVL3.5-8B-HF |
| GPU | 4 x NVIDIA RTX 4090 D |
| 同时推理 | 2 |
| 最大队列 | 16 请求 |
| 队列超时 | 120 秒 |
| 最大批量 | 32 张/次 |

## 认证

所有 `/generate` 和 `/batch` 接口需要 API Key 认证：

```
Authorization: Bearer <your-api-key>
```

或

```
X-API-Key: <your-api-key>
```

---

## 接口列表

### 1. 健康检查

**GET** `/health`

无需认证，检查服务状态。

**响应示例：**
```json
{
  "status": "ok",
  "model": "InternVL3.5-8B-HF",
  "port": 8001,
  "max_concurrent": 2,
  "max_queue_size": 16,
  "queue_timeout_sec": 120,
  "gpu_count": 4,
  "auth": "required"
}
```

---

### 2. 单图推理

**POST** `/generate`

分析单张图片。

**请求参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `image_base64` | string | 是 | 图片的 Base64 编码 |
| `prompt` | string | 否 | 提示词，默认 "描述这张图片" |
| `max_tokens` | int | 否 | 最大生成 token 数，默认 512 |

**请求示例：**
```bash
curl -X POST http://14.23.109.228:8001/generate \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "image_base64": "<base64编码的图片>",
    "prompt": "检测这张衣服图片的瑕疵，返回JSON格式",
    "max_tokens": 512
  }'
```

**响应示例：**
```json
{
  "response": "这张图片显示一件灰色T恤，在中央区域有一个明显的污渍...",
  "latency_ms": 2856.3,
  "queue_time_ms": 50.2
}
```

---

### 3. 批量推理

**POST** `/batch`

并行处理多张图片（最多 32 张）。

**请求参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `items` | array | 是 | 图片列表，每项包含 `image_base64` 和 `prompt` |
| `max_tokens` | int | 否 | 最大生成 token 数，默认 512 |

**请求示例：**
```bash
curl -X POST http://14.23.109.228:8001/batch \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {"image_base64": "<图片1>", "prompt": "检测瑕疵"},
      {"image_base64": "<图片2>", "prompt": "检测瑕疵"},
      {"image_base64": "<图片3>", "prompt": "检测瑕疵"},
      {"image_base64": "<图片4>", "prompt": "检测瑕疵"}
    ],
    "max_tokens": 512
  }'
```

**响应示例：**
```json
{
  "results": [
    {"index": 0, "response": "无瑕疵", "error": null},
    {"index": 1, "response": "发现污渍在区域5", "error": null},
    {"index": 2, "response": "发现破洞在区域3", "error": null},
    {"index": 3, "response": null, "error": "图片解码失败"}
  ],
  "total": 4,
  "latency_ms": 8234.5
}
```

**错误响应（超过批量限制）：**
```json
{
  "error": "Batch size 50 exceeds limit 32"
}
```

---

### 4. 服务状态

**GET** `/stats`

无需认证，查看 GPU 使用情况和队列状态。

**响应示例：**
```json
{
  "queue": {
    "max_concurrent": 2,
    "max_queue_size": 16,
    "timeout_sec": 120,
    "current_processing": 2,
    "current_waiting": 3,
    "slots_available": 2
  },
  "requests": {
    "total": 156,
    "completed": 150,
    "failed": 2,
    "rejected": 4
  },
  "gpus": [
    {"index": 0, "name": "NVIDIA GeForce RTX 4090 D", "memory_used_gb": 3.30, "memory_total_gb": 23.52},
    {"index": 1, "name": "NVIDIA GeForce RTX 4090 D", "memory_used_gb": 4.49, "memory_total_gb": 23.52},
    {"index": 2, "name": "NVIDIA GeForce RTX 4090 D", "memory_used_gb": 4.49, "memory_total_gb": 23.52},
    {"index": 3, "name": "NVIDIA GeForce RTX 4090 D", "memory_used_gb": 4.15, "memory_total_gb": 23.52}
  ]
}
```

---

## Python 调用示例

### 安装依赖
```bash
pip install httpx
```

### 单图调用
```python
import httpx
import base64

INTERNVL_URL = "http://14.23.109.228:8001"
API_KEY = "<your-api-key>"

def analyze_image(image_path: str, prompt: str = "描述这张图片") -> str:
    with open(image_path, "rb") as f:
        image_b64 = base64.b64encode(f.read()).decode()

    resp = httpx.post(
        f"{INTERNVL_URL}/generate",
        headers={"Authorization": f"Bearer {API_KEY}"},
        json={"image_base64": image_b64, "prompt": prompt, "max_tokens": 512},
        timeout=120
    )
    return resp.json()["response"]

# 使用
result = analyze_image("/path/to/image.jpg", "检测这张衣服的瑕疵")
print(result)
```

### 批量调用
```python
import httpx
import base64
from pathlib import Path

def batch_analyze(image_paths: list, prompt: str = "检测瑕疵") -> list:
    items = []
    for path in image_paths:
        with open(path, "rb") as f:
            image_b64 = base64.b64encode(f.read()).decode()
        items.append({"image_base64": image_b64, "prompt": prompt})

    resp = httpx.post(
        f"{INTERNVL_URL}/batch",
        headers={"Authorization": f"Bearer {API_KEY}"},
        json={"items": items, "max_tokens": 512},
        timeout=300
    )
    return resp.json()["results"]

# 使用
images = ["img1.jpg", "img2.jpg", "img3.jpg", "img4.jpg"]
results = batch_analyze(images)
for r in results:
    print(f"图片{r['index']}: {r['response']}")
```

### 服装瑕疵检测（9宫格定位）
```python
DEFECT_PROMPT = """你是专业的服装质检员，检查这张衣服图片是否有瑕疵。

图片被划分为 3x3 的 9 宫格区域（编号 1-9，从左上到右下）:
1 | 2 | 3
---------
4 | 5 | 6
---------
7 | 8 | 9

识别瑕疵类型：破洞(Hole)、污渍(Stains)、撕裂(Tears)、接缝开裂(Seam)

输出 JSON 格式：
{"has_defect": true/false, "defects": [{"zone": N, "type": "类型", "desc": "描述"}]}
"""

result = analyze_image("clothes.jpg", DEFECT_PROMPT)
print(result)
# 输出: {"has_defect": true, "defects": [{"zone": 5, "type": "污渍", "desc": "中央有明显污渍"}]}
```

---

## 错误码

| HTTP 状态码 | 说明 |
|------------|------|
| 200 | 成功 |
| 400 | 请求参数错误（如缺少 image_base64，或 batch size 超限） |
| 401 | API Key 无效 |
| 429 | 队列已满（超过 16 个等待请求），请稍后重试 |
| 500 | 服务器内部错误 |
| 503 | 队列等待超时（超过 120 秒） |

---

## 性能参考

| 场景 | 延迟 |
|------|------|
| 单图推理 | ~3 秒 |
| 4 图并行 | ~9 秒 |
| 32 图批量 | ~25 秒 |

## 并发行为

- **同时推理**: 最多 2 个请求同时进行 GPU 推理
- **队列等待**: 第 3-18 个请求进入队列等待
- **队列拒绝**: 超过 18 个请求时返回 429 错误
- **超时处理**: 队列等待超过 120 秒返回 503 错误

---

## 服务管理 (AIEX)

```bash
# SSH 到 AIEX
ssh AIEX

# 查看服务状态
export PATH=$PATH:~/local/node/bin
pm2 status

# 查看服务日志
pm2 logs internvl-server --lines 50

# 重启服务
pm2 restart internvl-server

# 查看 GPU 状态
nvidia-smi
```
