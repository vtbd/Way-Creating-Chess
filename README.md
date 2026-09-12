# Way Creating Chess · 网页版

主文件夹（`E:\Code\Python\Way Creating Chess`）里那款 Pygame 游戏的纯静态网页版：
零依赖、无需后端，把整个目录推到 GitHub Pages 就能直接玩。

规则与桌面版的 `game_engine.py` **完全一致**：在“可走”格落子后自动造路，在水平、垂直或两条对角线上先连成四子者获胜。

## 功能

- **棋盘初始化**：只内置桌面版 `OrBds.json` 里的那一个初始棋盘（默认 12×9，与 `py main.py` 启动时完全一样），棋盘库列表可双击直接开局；其余棋盘都来自随机生成、编辑器或导入。
- **自定义棋盘**：
  - 随机生成：宽/高 4-40、可走格密度、随机种子（相同种子可复现），并保证四条边各至少有两个可落子格；
  - 棋盘编辑器：封闭 / 可走 / A 方棋子 / B 方棋子四种工具，左键涂抹、右键擦除，可增删行列（4-40）；
  - 保存到浏览器（localStorage）、导入/导出与桌面版兼容的 `{"boards": [...]}` JSON；
  - 游戏中按 `P` 可把当前局面直接存成新的初始棋盘（棋子会转成可落子格，与桌面版 `current_as_initial_board()` 行为相同）。
- **双方落子**：A 方（蓝）先手，点击浅色格落子；自动造路、四连获胜、无格可走判和、撤销、重开、棋谱列表与导出。
- **AI 整合**：
  - 随机 AI；
  - 思考型 AI（Alpha-Beta + 迭代加深 + 着法排序 + 威胁/造路评估，与桌面版 `ai.py` 参数一致），在 Web Worker 中运行，思考时界面不卡；若浏览器不支持 Worker 会自动退回主线程并使用较短的思考预算。
- **双方身份切换**：A、B 两方各自可在“玩家 / 随机 AI / 思考型 AI”之间切换，也可一键“交换双方身份”；另有双人对战、我执 A、我执 B、AI 自对弈、随机 AI 演示等预设。

## 本地运行

页面使用 ES 模块与 Web Worker，**必须通过 HTTP 打开**（直接双击 `index.html` 会被浏览器拦截，页面会给出提示）。

```powershell
cd "E:\Code\Web\Way Creating Chess"
node tools\serve.mjs          # 然后访问 http://localhost:8000/
# 或者： py -m http.server 8000
# 或者： npx serve .
```

## 部署到 GitHub Pages

1. 新建一个 GitHub 仓库（例如 `way-creating-chess`），把本目录的文件推到 `main` 分支：

   ```powershell
   cd "E:\Code\Web\Way Creating Chess"
   git init
   git add .
   git commit -m "Way Creating Chess web version"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/way-creating-chess.git
   git push -u origin main
   ```

2. 打开仓库 **Settings → Pages**，Source 选 **Deploy from a branch**，分支选 `main`、目录选 `/ (root)`，保存。
3. 等一分钟左右，访问 `https://<你的用户名>.github.io/way-creating-chess/`。

所有资源都使用相对路径，因此放在仓库子目录（项目页）下也能正常工作；`.nojekyll` 已包含在内。

> 也可以把本目录作为用户主页仓库 `https://github.com/<你的用户名>/<你的用户名>.github.io` 的内容，直接访问根域名即可。

## 操作说明

| 操作 | 快捷键 | 说明 |
| --- | --- | --- |
| 落子 | 左键 | 只能点击浅色“可走”格 |
| 撤销 | `U` / `Backspace` | 人机对战时会把回合还给你 |
| 重开当前棋盘 | `R` | 恢复到本局初始局面 |
| 新棋盘 / 自定义 | `N` | 打开棋盘库与随机生成面板 |
| 编辑棋盘 | `E` | 从当前局面开始编辑 |
| AI 参数 | `T` | 搜索深度（1-12）、思考时间（0.1-60 秒）、候选着法上限（100-20000） |
| 保存棋谱 | `S` | 下载 `way-chess-record-*.json` |
| 保存当前棋盘 | `P` | 存进浏览器里的“我的棋盘” |
| 规则说明 | `H` | 打开规则面板 |
| 切换 A / B 方控制 | `1` / `2` | 玩家 → 随机 AI → 思考型 AI 循环 |
| 编辑器工具 | `1`-`4` | 封闭 / 可走 / A 棋子 / B 棋子；`Esc` 取消 |

棋谱使用桌面版相同的结构（`size`、`moves`、`result`），额外附带的 `board` 字段记录棋盘来源，便于和 Python 版互相对照。

## 目录结构

```
index.html                 页面骨架（棋盘、侧栏、弹窗容器、file:// 提示）
css/styles.css             全部样式，配色取自桌面版 view.py
assets/icon.svg            站点图标
js/engine.js               规则引擎（game_engine.py 的移植：造路、胜负、和棋、撤销、棋谱）
js/ai.js                   随机 AI 与 Alpha-Beta 思考型 AI（ai.py 的移植）
js/ai-worker.js            Web Worker 包装，把搜索放到后台线程
js/boards.js               棋盘库：内置棋盘、随机生成、localStorage、导入导出
js/boards-data.js         由 tools/generate-boards-data.mjs 生成的初始棋盘数据
js/editor.js               棋盘编辑器数据模型
js/board-view.js           DOM 棋盘渲染
js/preview.js              棋盘缩略图（canvas）
js/dom.js                  DOM 小工具
js/app.js                  界面编排：落子、AI 调度、面板、快捷键
tools/serve.mjs            本地静态服务器（零依赖）
tools/generate-boards-data.mjs  从 Python 项目重新生成 js/boards-data.js
tests/                     Node 测试（node --test tests/*.test.mjs）
```

## 测试

```powershell
npm test            # 等价于 node --test tests/*.test.mjs
```

测试包含：

- 规则引擎的回归用例（与桌面版 `test_game_engine.py` 一一对应）：造路、对方棋子阻断、四连获胜、和棋、克隆独立、撤销还原；
- AI 用例（与桌面版 `test_ai.py` 一一对应）：立即取胜、封堵必败、劣势时选择拖延最久的防守，验证网页版与 Python 版选出同一手棋；
- 棋盘库用例：内置预设与 Python 项目 `OrBds.json` 逐格一致（且只有一个预设），随机棋盘边角可达、同种子可复现、导入导出往返；
- 界面冒烟测试：在内存 DOM 中真实启动 `js/app.js`，模拟点击落子、AI 自动行棋、切换身份、打开各面板、编辑棋盘与保存棋盘。

## 与桌面版的关系

网页版不修改 Python 项目，只读取它的棋盘数据。棋盘 JSON 双向兼容：

- 网页版“导出我的棋盘”得到的文件，可直接作为桌面版的 `saved_boards.json`（复制到 exe 或 `py main.py` 所在目录）；
- 反过来，桌面版保存的棋盘文件也可以通过网页版的“导入 JSON”载入；
- 想让网页版把桌面版的其他棋盘也作为内置预设，把它们放进 Python 项目目录的 `OrBds.json` 后执行 `npm run build:boards`（网页版只读取 `OrBds.json`；桌面版的 `saved_boards.json` 请用页面里的“导入 JSON”载入，或直接在浏览器里编辑保存）。
