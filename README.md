# 频道关键词日报

一个本地运行的腾讯频道关键词监控工具。它通过已登录账号的 HTTP 接口抓取指定频道内容，按关键词筛选、去重、按日期过滤，并可导出日报或推送到企业微信/飞书。

> 本项目不内置任何 Cookie、账号、Webhook 或频道私有数据。开源仓库只包含程序代码和示例配置。

## 功能

- 指定频道、关键词、日期范围抓取
- 支持频道内搜索补全，提高关键词命中覆盖率
- 展示最近抓取样本和历史命中报告
- 导出 Markdown/HTML 日报
- 企业微信/飞书机器人通知
- Cookie 过期识别和重新导入提示
- Windows 计划任务每日自动运行
- 本地 Web UI，默认地址 `http://localhost:8787`

## 环境

- Node.js 18 或更高版本
- Windows 可选：用于安装每日计划任务和文件夹选择器
- 一个可正常访问 `https://pd.qq.com/` 的已登录浏览器账号

## 快速开始

```powershell
npm install
npm start
```

打开：

```text
http://localhost:8787
```

如果 `8787` 端口被占用：

```powershell
$env:PORT=8788
npm start
```

## 首次配置

1. 打开本地页面 `http://localhost:8787`
2. 点击“导入频道接口模板”
3. 在 Chrome 打开并登录 `https://pd.qq.com/`
4. 在本地页面展开“登录设置”，复制“控制台导入脚本”
5. 回到 `pd.qq.com` 页面，打开 DevTools Console，粘贴执行
6. 控制台返回 `hasPSkey: true` 且 `hasUin: true` 后，回到本地页面保存配置
7. 点击“立即爬取”验证

也可以在 Chrome DevTools 的 Network 面板中复制对应请求的 Cookie 或 cURL，再粘贴到页面里的“登录设置 / 请求设置”。

## 配置文件

程序首次运行会自动创建：

```text
data/config.json
data/messages.json
data/runs.json
data/last-scan.json
data/guild-map.json
```

这些文件包含本地登录态、Webhook、运行记录或抓取结果，已经被 `.gitignore` 排除，不要提交到公开仓库。

根目录提供了无敏感信息的示例配置：

```text
config.example.json
```

## 日报和通知

在页面中勾选“导出日报”后，爬取完成会在配置的输出目录生成：

```text
YYYY-MM-DD.md
YYYY-MM-DD.html
```

通知设置支持：

- 企业微信机器人 Webhook
- 飞书机器人 Webhook
- 飞书签名 Secret
- 仅命中时通知
- 命中消息预览数量

## 每日自动运行

单次运行：

```powershell
npm run once
```

安装 Windows 每日计划任务：

```powershell
npm run install-task
```

计划任务名称：

```text
PDKeywordReporterDaily
```

## Cookie 过期

如果出现以下错误，通常是 Cookie 已过期或导入不完整：

- `4002: uin not found`
- `4003: invalid pskey`
- `未登录`
- `登录态失效`

重新在 `pd.qq.com` 已登录页面执行“控制台导入脚本”即可。导入成功应看到：

```js
{ ok: true, hasPSkey: true, hasUin: true }
```

## 安全说明

- 不要提交 `data/`、`reports/`、抓包缓存、真实 Cookie 或 Webhook
- 本工具仅供个人本地自动化和信息整理使用
- 使用时应遵守目标平台服务条款和所在组织的数据合规要求

## License

MIT
