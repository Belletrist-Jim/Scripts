# 上海东方艺术中心 · 抢票助手

> Tampermonkey userscript for shoac.com.cn — auto-picks adjacent seats on the seat page and locks them
> into the cart, plus restock/on-sale monitoring on the performance page.

一个油猴脚本，帮你在 **www.shoac.com.cn**（东艺）上：

- **在线选座页**：按你设定的价位 / 区域 / 张数自动挑**连座**并锁进购物车（= 抢到了）；
- **演出详情页**（可选）：盯每一场的**余票 / 放票 / 开售**，桌面通知 + 响铃 + 一键打开选座页。

付款永远手动；需要滑块验证时脚本无法代过，会改成"替你把座位点好"。

---

## 一、装上（3 分钟，只需一次）

1. 浏览器装 **Tampermonkey**（Chrome / Edge / Firefox）。
2. **Chrome 必做**：`chrome://extensions` → Tampermonkey「详情」→ 打开「**允许用户脚本**」。
3. 装脚本，二选一：
   - **最快**：油猴面板「+ 新建脚本」→ 把 `shoac.user.js` 内容整段粘进去 → 保存；
   - **走本地服务**：本目录执行 `./build.sh serve`，浏览器打开 `http://127.0.0.1:8772/shoac.user.js` 安装。
4. 打开官网，左下角出现面板；控制台有 `[SOAC] 已加载…`。

## 二、抢票当天

1. 登录 → 演出详情页 → 选场次 → 点「**选座购买**」进入在线选座页
   （地址形如 `.../#/selectPurchase/selectSeat?productId=..&showId=..&sectionId=..`）。
2. 点面板 **「自检/复制」**：确认能读到场次、真实价位、分区、余票。
3. 按真实价位改 `config.yaml` 的 `rules` → `./build.sh build` → 油猴「检查更新」→ 刷新。
4. 点 **「预演」**（只算不锁）→ 满意后点 **「一键抢座」**。

   | 快捷键 | 作用 |
   | --- | --- |
   | `Alt+Shift+T` | 自检 |
   | `Alt+Shift+P` | 预演 |
   | `Alt+Shift+R` | 一键抢座 |
   | `Alt+Shift+I` | 本分区库存 |
   | `Alt+Shift+S` | 全场扫描（哪个分区有票） |

5. 锁到座位后自动跳「提交订单」页：在哪挑选票方式/实名 → 提交订单 → 付款（**自己付**）。
   万一没跳过去：刷新后执行 `SOAC.order()`，或点面板「去订单页」。

> 想零点击：`autoRun: true`；想先演练：`dryRun: true`（选座页一打开只打印会挑哪些座）。

## 三、配置 `config.yaml`

```yaml
dryRun: false           # true = 只预演，绝不锁座
autoRun: false          # true = 选座页一打开就自动抢
submitOrder: true       # true = 真正调锁座接口
maxRetry: 4             # 座位被抢走时自动刷新重挑的轮数
mode: auto              # auto / api / dom（见下）
jumpToOrder: true       # 锁座成功自动跳提交订单页
autoSwitchSection: true # 当前分区没票时自动换分区
rowPreference: middle   # front / middle / back

rules:
  - price: 480          # 真实价位（自检里能看到）
    qty: 2
    areas: []           # 区域名片段，如 ["1楼","乐池"]；空 = 不限

# —— 余票监控（详情页）——
programId: ""           # 留空 = 从页面 URL 自动识别
pollMs: 20000           # 查询间隔（开票前可调到 3000）
minSeats: 1             # 余票 ≥ 这个数才提醒
notify: true
sound: true
autoOpen: false         # 放票时自动开该场次选座页
```

**三种执行方式**：

| mode | 行为 |
| --- | --- |
| `auto`（默认） | 不需要滑块 → 直接调锁座接口（最快）；需要滑块或接口失败 → 自动改用"网页点选"，你拖一下滑块 |
| `api` | 只走接口 |
| `dom` | 只走网页点选（由页面自己锁座） |

**挑座规则**：按 `areas` 顺序选区域 → 同排连座 → 上下排相邻 → 散座；同一条连座里越靠中间越好。

## 四、出问题怎么办

先点 **「自检/复制」**，把 JSON 发我/维护者（含路由、场次、真实价位、分区、余票和登录状态）。

| 现象 | 原因 / 处理 |
| --- | --- |
| 没有面板、控制台无 `[SOAC]` | 油猴没生效：确认脚本启用 + Chrome 开了「允许用户脚本」，再刷新 |
| 自检说"未登录/没有 token" | 先在官网登录，再回选座页刷新 |
| 面板提示"这场需要滑块验证" | 正常，脚本会自动替你点好座位并点结账，你拖一下滑块 |
| "本分区凑不齐" | 点「全场扫描」看别的分区；开了 `autoSwitchSection` 脚本会自己切过去继续抢 |
| 锁座成功但没跳到提交订单页 | 刷新后 `SOAC.order()`，或点面板「去订单页」 |
| 提交订单页说"您还有未支付的订单" | 先去「我的订单」取消或付款，再抢 |

## 五、文件说明

| 文件 | 作用 |
| --- | --- |
| `shoac.user.js` | **装到油猴的就是这个**（由 config.yaml + engine.js 生成） |
| `config.yaml` | 唯一需要改的文件 |
| `engine.js` | 逻辑本体 |
| `build.mjs` | 生成脚本（内置极简 YAML 解析，**不需要 npm 依赖**） |
| `build.sh` | 构建 / 本地安装服务 |
| `build.cmd` | Windows 下的构建入口（双击即可） |

## 六、说明

- 脚本调用官网自己的接口、用你浏览器的登录态，等价于手动操作；请遵守场馆购票规则。
- **不代付**，也不替你过验证码。锁座后座位由购物车/订单占着，超时会释放。
- 转发给别人前，记得清掉 `config.yaml` 里的个人信息。

> **Windows 用户**：`build.cmd` 双击即可重新生成（需装 Node.js）；`build.sh` 需要在 Git Bash / WSL 里跑。
> 不想装任何东西也行 —— 油猴面板「实用工具 → 从文件导入」选 `shoac.user.js` 就能安装。
