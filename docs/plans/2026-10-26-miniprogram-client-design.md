# LiaoYu 小程序端设计（原生小程序，单包双角色）

日期：2026-10-26
状态：已确认

## 背景与目标

LiaoYu（陪伴咨询平台）后端 `apps/server` 已交付学员/老师双角色全量接口（认证、套餐、订单支付、排班预约、请假代班、IM/TRTC、通知、结算），但前端小程序工程缺失。微信开发者工具打开 `wx/` 目录报「app.json is not found」正是因为没有小程序工程。

目标：新建 `apps/miniprogram` 原生小程序工程，首版打通学员核心闭环（登录 → 浏览老师 → 买套餐 → 预约 → 我的服务），老师角色首版提供最小可用视图。

## 已确认的决策

- **单个小程序双角色**：登录后按 `/api/auth/me` 返回的角色（有无 teacherProfile）渲染不同视图，共用一套请求层。
- **技术栈**：微信原生小程序，纯 JS，零构建链路；微信开发者工具直接打开 `apps/miniprogram` 即可运行。
- **首版范围（MVP）**：
  1. 登录 + 角色主框架（微信登录、角色识别、个人资料）
  2. 老师浏览 + 套餐购买（公开老师列表/详情/周排班展示、套餐下单、ZPAY 支付）
  3. 排班预约 + 我的服务（选时段预约、取消、我的服务列表）
- **不在首版**：IM 聊天、TRTC 通话、通知中心、老师端编辑排班/请假/代班操作（页面与 tabBar 预留扩展位，后续迭代）。
- **工程位置**：`LiaoYu/apps/miniprogram`（与 server 同仓）。
- **AppID**：开发阶段用测试号（`project.config.json` 写占位 appid），后续换正式 appid。

## 方案选择：双角色页面组织

采用 **方案 A：静态 tabBar + 首页双视图**。

- tabBar 固定「首页 / 我的服务 / 我的」，各页按角色渲染学员/老师视图。
- 否决自定义 tabBar（维护自定义组件、切栏闪烁）与分包（首版体量小，分包收益为负）。
- 后续功能变多时可演进为学员/老师分包。

## 架构设计

### 目录结构

```
apps/miniprogram/
  app.js / app.json / app.wxss     # 全局：启动静默登录、主题样式
  sitemap.json
  project.config.json              # 测试号 appid 占位
  config/env.js                    # baseURL：dev http://localhost:8700，prod https://$DOMAIN
  utils/request.js                 # wx.request promise 封装；Bearer token 注入；401 自动重登
  utils/auth.js                    # wx.login → POST /api/auth/wxlogin；token/角色存 storage
  utils/format.js                  # 时间/金额/状态文案格式化
  pages/
    index/                         # 首页：学员=老师列表；老师=今日服务概览
    services/                      # 我的服务：学员=套餐/预约/关系；老师=预约列表
    profile/                       # 我的：资料、角色、设置
    login/                         # 登录与角色识别页
    teacher/detail/                # 老师详情（含周排班展示）
    package/buy/                   # 套餐确认与支付
    appointment/book/              # 选时段预约
```

### 关键流程

- **登录**：启动静默 `wx.login` 取 code → `POST /api/auth/wxlogin {code}` → `{token, user}` → token 存 storage → `GET /api/auth/me` 判角色 → 路由分发。token 失效（401）时在 request 层自动重登一次并重放请求。
- **鉴权**：后端为 `Authorization: Bearer <token>`，无需 cookie；小程序本地仅存 token 与角色，不存敏感信息。
- **购买**：老师详情 → 套餐列表 → `POST /api/orders` 下单 → 支付适配层：
  - MOCK 环境（后端未配 `ZPAY_PID/ZPAY_KEY`）：「模拟支付成功」按钮回调后端确认接口，走通全流程；
  - 正式环境：接 `wx.requestPayment`。**ZPAY 与小程序 JSAPI 支付的参数对接是唯一外部风险点**，首版先留适配接口、以 MOCK 打通闭环，正式对接单独排期。
- **预约**：详情页看老师周排班 → 选时段 → `POST /api/appointments` → 「我的服务」查看/取消。
- **错误处理**：request 层统一 toast 后端 `error` 字段；页面级 loading/empty 态；网络异常提示重试。

### 接口依赖（首版）

`POST /api/auth/wxlogin`、`GET /api/auth/me`、`GET /api/teachers*`（公开老师列表/详情）、`GET/POST /api/teacher/packages`（公开读取）、`POST /api/orders`、`/api/pay/*`、`GET /api/teacher/schedule/*`（公开读取周排班）、`POST/GET/DELETE /api/appointments`、`GET /api/relations`、`GET /api/teacher/appointments`（老师端）。

### 环境与联调

- 开发：后端 `pnpm -F @liaoyu/server dev`（http://localhost:8700），未配 `WX_APPID/WX_APPSECRET` 时登录走 MOCK；开发者工具勾选「不校验合法域名」直连本地。
- 生产：小程序后台把 `https://$DOMAIN` 加入 request 合法域名，`config/env.js` 切 baseURL。
- 小程序端不加单测框架（零构建原则），验证靠工具/真机手工冒烟走全流程；后端质量由现有 `pnpm check`（174 用例）保障。
