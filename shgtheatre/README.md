# 上海大剧院 · 抢票助手

> Tampermonkey userscript for shgtheatre.com — picks seats by price/area, locks them,
> then auto-advances the confirm page and stops at the QR code. Payment stays manual.

一个油猴脚本，帮你在 **www.shgtheatre.com**（上海大剧院）上：

- **选座页**：按你设定的价位 / 区域 / 张数自动挑**连座**并锁座（生成待付款订单）；
- **确认页**：自动勾协议 + 点「确认支付」，把**付款二维码**弹出来（`autoAdvanceToPay`）；
- **演出详情页**（可选）：盯开票，目标场次一开卖就自动进选座页（`watch`）。

付款永远手动 —— 脚本不碰支付，也不替你过验证码。

---

## 一、装上（3 分钟，只需一次）

1. 浏览器装 **Tampermonkey**（Chrome / Edge / Firefox）。
2. **Chrome 必做**：`chrome://extensions` → Tampermonkey「详情」→ 打开「**允许用户脚本**」。
   （新版 Chrome 默认关闭，不开就会静默失效。）
3. 装脚本，二选一：
   - **最快**：油猴面板「+ 新建脚本」→ 把 `shgtheatre.user.js` 内容整段粘进去 → 保存；
   - **走本地服务**：本目录执行 `./build.sh serve`，浏览器打开 `http://127.0.0.1:8771/shgtheatre.user.js` 安装。
4. 打开官网，左下角出现面板；控制台有 `[SGT] 已加载…`。

## 二、抢票当天

1. 登录 → 在线购票 → 点开演出 → 选场次 → 进入**选座页**
   （地址形如 `.../#/ticket/seats/12345?pk=..&sk=..`）。
2. 先点面板 **「自检/复制」**：确认能读到场次/价位/区域/余票，并看清**真实价位**。
3. 按真实价位改 `config.yaml` 的 `rules` → `./build.sh build` → 油猴「检查更新」→ 刷新。
4. 点 **「预演」** 看会挑哪些座 → 满意后点 **「一键抢座」**。

   | 快捷键 | 作用 |
   | --- | --- |
   | `Alt+Shift+T` | 自检 |
   | `Alt+Shift+P` | 预演 |
   | `Alt+Shift+R` | 一键抢座 |
   | `Alt+Shift+I` | 库存（区域 × 价位） |

5. 抢到后会生成**待付款订单**（座位已归你）；脚本可自动跳到确认页并点「确认支付」，
   弹出二维码后**你自己扫码付款**。确认页地址不带在 URL 里也没关系，脚本会用页面自己的路由跳。

> 想零点击：`autoRun: true`（默认已开）。想先演练：`dryRun: true`。

## 三、配置 `config.yaml`

```yaml
dryRun: false           # true = 只预演，绝不下单
autoRun: true           # true = 打开选座页就自动抢
submitOrder: true       # true = 真正下单锁座
maxRetry: 6             # 座位被抢走时自动刷新重挑的轮数
jumpToConfirm: true     # 抢到后自动跳确认页
autoAdvanceToPay: true  # 确认页自动勾协议 + 点「确认支付」，停在二维码
mobile: ""              # 留空 = 用账号手机号；要覆盖再填 11 位号码
certificationIds: []    # 实名场次用；留空 = 自动取第一条实名信息
rowPreference: middle   # front 前排优先 / middle 中间排 / back 后排优先

rules:                  # 备选链：从上往下试，第一条能凑齐就下单
  - price: 680          # 真实价位（点「自检」看）
    qty: 2
    areas: []           # 区域片段，如 ["A","B"] 或 ["一楼"]；空 = 不限
```

**挑座规则**：按 `areas` 顺序选区域 → 同排连座优先 → 上下排相邻 → 散座；同一条连座里越靠中间越好。

## 四、出问题怎么办

先点 **「自检/复制」**，把弹出来的 JSON 发给我/维护者（含路由、场次、真实价位、区域、余票、账号状态）。

| 现象 | 原因 / 处理 |
| --- | --- |
| 没有面板、控制台无 `[SGT]` | 油猴没生效：确认脚本启用 + Chrome 开了「允许用户脚本」，再刷新 |
| 提示"未登录/登录已过期" | 先在官网登录，再回选座页刷新 |
| 规则全部"凑不齐" | 点「自检」看真实价位，改成存在的档位；热门场次多写几条降级规则、减少张数 |
| 提示"有未支付订单" | 去「我的订单」把上一单取消或付款，再抢 |
| 需要滑块验证 | 脚本自动改成"替你把座位点好 + 点结账"，你拖一下滑块即可 |

## 五、文件说明

| 文件 | 作用 |
| --- | --- |
| `shgtheatre.user.js` | **装到油猴的就是这个**（由 config.yaml + engine.js 生成） |
| `config.yaml` | 唯一需要改的文件 |
| `engine.js` | 逻辑本体 |
| `build.mjs` | 生成脚本（内置极简 YAML 解析，**不需要 npm 依赖**） |
| `build.sh` | 构建 / 本地安装服务 |
| `build.cmd` | Windows 下的构建入口（双击即可） |

## 六、说明

- 脚本调用官网自己的接口、用你浏览器的登录态，等价于手动操作；请遵守场馆购票规则，不要囤票倒票。
- **不代付**，也不替你过验证码。锁座后是"待付款订单"，通常 15 分钟内有效。
- 转发给别人前，记得清掉 `config.yaml` 里的 `mobile` 等个人信息。

> **Windows 用户**：`build.cmd` 双击即可重新生成（需装 Node.js）；`build.sh` 需要在 Git Bash / WSL 里跑。
> 不想装任何东西也行 —— 油猴面板「实用工具 → 从文件导入」选 `shgtheatre.user.js` 就能安装。
