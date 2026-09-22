# Secure RDP Manager 产品优化计划

> 基于产品视角审视（2026-09-22），按优先级分阶段推进。

## 愿景

让个人或小团队以最低认知成本安全地把内网服务（RDP/SSH/HTTP）暴露到公网。

## 当前状态

- 功能闭环完整：代理路由、白名单、FRP 隧道、RDP 开关、HTTPS 终止、Docker 部署
- 安全基础在线：Proxy Protocol v2、临时白名单过期、RDP 自动关闭、原子写入
- 中文 UI + Basic Auth，面向自托管用户

---

## P0 — 高价值 / 低门槛（当前版本优先）

### 连接可观测性

- [x] 新增 `GET /api/connections` 接口，解析 `log/proxy_connections.*.log` 返回最近 N 条连接记录
- [x] 返回字段：时间、来源 IP、目标 host:port、协议（TCP/HTTP）、匹配子域、是否被白名单拒绝
- [x] 前端控制台新增「最近连接」面板，展示列表 + 拒绝次数高亮
- [x] 被拒绝的连接用红色/警示样式标记，作为安全信号

### 临时访问链接

- [x] 新增 `POST /api/access-link` 接口：生成一次性 token + 有效期（默认 15 分钟），返回可分享的 URL
- [x] 新增 `GET /access/:token` 页面：验证 token 后自动将访问者 IP 加入临时白名单
- [x] token 单次使用，过期自动清理（内存或 SQLite 均可）
- [x] 前端「生成临时链接」按钮 + 复制到剪贴板
- [x] 到期后自动从临时白名单移除，UI 显示剩余时间

---

## P1 — 降低门槛（下一版本）

### 首次启动向导

- [ ] 检测 `production.json` 不存在或 `PROXY_TARGETS` 为空时，重定向到 `/setup` 向导页
- [ ] 向导步骤 1：设置管理员用户名和密码（替代 `.env` 手动编辑）
- [ ] 向导步骤 2：填入 frps 地址和 token，自动生成 `frpc.toml`
- [ ] 向导步骤 3：选择安全档位（严格/标准/开放）
- [ ] 向导步骤 4：「测试连通性」按钮，逐项检查 frps 可达、token 有效、端口未占用
- [ ] 完成后写入配置并重启服务，跳转到控制台主页

### 安全档位抽象

- [ ] 定义三个预设档位，存入 config：
  - 严格：仅静态白名单 + RDP 自动关闭
  - 标准：临时白名单 + 临时访问链接
  - 开放：跳过 IP 白名单，仅靠上游认证
- [ ] 控制台顶栏提供档位切换（segmented control）
- [ ] 高级设置（Proxy Protocol、HTTPS 终止等）折叠到「高级」区域

---

## P2 — 增强体验（后续版本）

### 控制台信息架构重构

- [ ] 将 RDP/白名单/FRP/端口四张并列卡片改为管道视图（依赖链：你的 IP → RDP → FRP → 可连接）
- [ ] 每个节点显示状态图标和一行摘要，一眼定位「卡在哪一步」

### 告警通知

- [ ] 集成 Webhook 通知（支持自定义 URL，兼容 Telegram/Server酱/Discord 格式）
- [ ] 触发场景：frpc 进程退出、白名单拒绝次数突增（阈值可配）、RDP 自动关闭
- [ ] 设置页新增通知配置区域

### 双因素认证

- [ ] 引入 TOTP（Google Authenticator 兼容），登录后要求输入验证码
- [ ] 首次启用时展示二维码和备份码
- [ ] Basic Auth 升级为 session-based 登录 + TOTP

### 配置备份与恢复

- [ ] 「导出配置」按钮：打包 `production.json` + `.env` + `frpc.toml` + `whitelist.ini` 为加密 JSON
- [ ] 「导入配置」按钮：解密并写回各文件，重启服务
- [ ] 容器启动时检测到无配置，提示用户是否有备份可恢复

### 国际化

- [ ] 前端文案抽取为 i18n 资源文件
- [ ] 支持中/英文切换，语言跟随浏览器 Accept-Language 或手动选择

### 移动端适配

- [ ] 控制台响应式布局优化（当前在窄屏下可读性待验证）
- [ ] 关键操作（开关、生成链接）在移动端有合理的触控热区

---

## 技术债 / 顺手改

- [x] `html lang="en"` 改为 `lang="zh-CN"`
  - [x] 两个 CSS 文件（`styles.css` / `modern-styles.css`）确认是否需要合并，删除未引用的
  - [x] `src/daemon/` 目录下的日志和 exe 不应提交到 git，加入 `.gitignore`（已确认 `daemon` 规则覆盖，文件未被 git 跟踪）
  - [x] `config/.env` 和 `config/certs/` 确认是否已在 `.gitignore` 中（避免泄漏）（已确认均被覆盖）
  - [x] API 返回统一错误格式 `{ error, code }`，方便前端精确处理
  - [x] `config/frpc-https.toml` README 已标注废弃，从仓库移除
