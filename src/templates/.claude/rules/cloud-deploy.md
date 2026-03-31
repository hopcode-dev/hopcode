# 云部署 MCP

## 阿里云部署

### 准备工作
用户需要提供：
- AccessKey ID
- AccessKey Secret
- 目标区域（如 cn-hangzhou）

### MCP 工具

| 工具 | 用途 |
|------|------|
| `aliyun_deploy` | 部署应用到阿里云 ECS |
| `aliyun_check_status` | 检查部署状态 |

### 部署流程
1. 用户授权 AccessKey
2. 小码构建应用
3. 用 `aliyun_deploy` 上传并启动
4. 返回公网地址

## 腾讯云部署

类似阿里云，用户提供 SecretId/SecretKey 和目标地域。

## 亚马逊 AWS

用户需要 IAM credentials，建议通过环境变量配置，不在对话中传输。

## 安全提示

AccessKey 相当于密码，只在必要时提供，不要记录到代码中。
