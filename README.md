# Project Poluxis（暂名）

一款基于Web的 **第一人称 3D 下落式音乐节奏游戏**。

音符从深处向屏幕飞来，玩家在判定面处按节奏点击 / 滑动 / 长按，命中越精准得分越高。内置谱面编辑器，支持鼠标与**多点触控**，也能导入外部谱面 JSON 与音频游玩。

> 项目完全开源，可自由部署到任意静态托管平台。

---

## 目录

- [怎么玩](#怎么玩)
- [快速开始（本地运行）](#快速开始本地运行)
- [谱面怎么导入](#谱面怎么导入)
- [本地谱面库管理](#本地谱面库管理)
- [如何打包 ZIP 谱面包](#如何打包-zip-谱面包)
- [添加自己的谱面 / 封面 / 音乐（beatmaps）](#添加自己的谱面--封面--音乐beatmaps)
- [搭建在线谱面服务器](#搭建在线谱面服务器)
- [谱面编辑器](#谱面编辑器)
- [编辑器放置规则（DSL）](#编辑器放置规则dsl)
- [如何部署](#如何部署)
- [作为 PWA 安装 / 离线可用](#作为-pwa-安装--离线可用)
- [自定义皮肤](#自定义皮肤)
- [自定义 UI 与打击音效（sounds）](#自定义-ui-与打击音效sounds)
- [项目结构（简览）](#项目结构简览)
- [常见问题](#常见问题)

---

## 怎么玩

1. 打开游戏进入**选歌界面**，挑选一首曲子（内置示范谱面，或你导入的谱面）。
2. 选择难度后开始游戏，音符会沿轨道下落。
3. 在音符到达**判定线**时进行操作：
   - **Tap（点触）**：单击 / 点按对应位置。
   - **Slide（滑条）**：按住并沿轨迹滑动，滑条上的每个节点都要经过判定线。
   - **Touch（连点）**：手指快速划过，沿轨迹生成一串连续音符。
4. 命中越准，评价越高（Perfect / Good / Miss），结算界面会显示得分、准确率与达成徽章。
5. 支持**自动演奏（AutoPlay）**模式，用于试听谱面或挂机演示。

---

## 快速开始（本地运行）

需要本地已安装 **Node.js 18+**。

```bash
# 1. 安装依赖
npm install

# 2. 启动开发服务器（默认 http://localhost:61616 ）
npm run dev

# 3. 构建生产版本到 dist/ 目录
npm run build

# 4. 本地预览构建结果
npm run preview
```

> 游戏运行必需的内置资源（命中音效等）由代码内合成器兜底，开箱即用，无需额外音频文件。

---

## 谱面怎么导入

支持从本地文件导入你自己的谱面与音乐，无需改代码。**在选歌界面点击底部 FAB（悬浮按钮）的「导入」**，即可选择：

- **ZIP 谱面包**：一次导入整张专辑 / 多首歌曲（打包规范见[下文](#如何打包-zip-谱面包)）。
- **散文件**：谱面 JSON + 音频 + 封面，自动整理为一首歌曲。

支持的文件类型：谱面 `.json` / `.chart`，音频 `mp3 / wav / ogg / m4a / aac / flac / webm`，封面 `png / jpg / jpeg / webp / gif / bmp`。导入后曲目会进入**本地谱面库**（详见[本地谱面库管理](#本地谱面库管理)），随后即可游玩。

### 编辑器内导入 / 导出

在谱面编辑器中，左侧「导入导出」面板可以：

- **导入音频** 与 **导入谱面 JSON**；
- **导出 JSON**：把当前正在编辑的谱面下载为 `.json` 文件，方便分享或备份。

### 谱面 JSON 格式（简要）

一个谱面文件是包含 `metadata`、`notes`、`events`（可选） 的 JSON 对象：

```jsonc
{
  "metadata": {
    "title": "曲目名",
    "artist": "作者",
    "difficulty": "Hard Lv.6",   // 名称，可带可选等级 Lv.x
    "bpm": 160,                  // beat 0 处的基础 BPM，必须大于 0
    "offset": 0,                 // 音频偏移（秒），用于校准音画
    "jacket": "cover.png",       // 可选：封面图路径（相对服务器目录 / zip 内路径）
    "noteColor": "#00f0ff",
    "bgScheme": { "gradientStart": "#1e293b", "gradientEnd": "#0b0f17", "accentColor": "#00f0ff" },
    "bpmlist": [ { "beat": 8, "bpm": 180 } ]   // 可选：中途变速点（升序，首点不能在 beat 0）
  },
  "notes": [
    { "type": "tap",    "beat": 4,    "x": 0.5, "y": 0 },
    { "type": "slide",  "beat": 8,    "x": -1,  "y": 0,
      "nodes": [ { "beat": 9, "x": 1, "y": 0 }, { "beat": 10, "x": 0, "y": 0 } ] },
    { "type": "touch",  "beat": 12,   "x": 0.2, "y": 0 }
  ],
  "events": [
    { "eventType": "speed_change",  "beat": 4, "speed": 1.5 },
    { "eventType": "text_display",  "beat": 8, "text": "GO!", "textDuration": 2 }
  ]
}
```

- `beat`：以**拍**为单位的出现时间（不是秒，也不是小节），默认以4分音符为一拍。
- `x`：横向位置，范围约 `-2.4 ~ 2.4`；`slide` 的 `nodes` 为滑条中间节点，每个节点同样有 `beat` / `x` / `y`。
- 事件 `eventType` 支持：`speed_change`（变速，`speed`）、`text_display`（文字，`text` / `textDuration` / `x` / `y` / `fontSize` / `color`）、`note_color_change`（音符变色，`noteColor`）、`bg_change`（背景变色，`gradientStart` / `gradientEnd`）。旧版 `speedEvents` 数组仍兼容导入。
- 编辑器导出的 JSON 已符合上述格式，可直接复用。

> 校验规则：导入时若缺少 `metadata` 或 `bpm` 非法，会提示具体错误。

---

## 本地谱面库管理

所有导入、下载的谱面都保存在浏览器的 **IndexedDB 本地谱面库**中，与内置 / 在线谱面一起在选歌界面展示。展开任一本地曲目卡片，即可通过底部按钮进行管理：

| 按钮 | 功能 |
| --- | --- |
| 编辑 | 修改曲目名、作者、BPM、强调色，增删难度 |
| 编辑谱面 / 新建谱面 | 进入编辑器修改或创建该曲目的谱面 |
| 导入谱面 | 上传一个谱面 JSON 作为新的难度 |
| 更换音频 / 更换封面 | 为该曲目绑定 / 替换音频与封面图 |
| 移动 | 把曲目 / 专辑移动到其他专辑或**库根目录**（根目录支持独立曲目，无需专辑包裹） |
| 删除 | 删除曲目或专辑（其引用的谱面 / 音频 / 封面文件若不再被其它歌曲使用会一并清理） |

其他说明：

- **新建曲目**：选歌界面 FAB → 「新建曲目」。若在根目录创建，则直接生成库根独立曲目；若在某个专辑内，则加入该专辑。
- **新建专辑 / 嵌套专辑**：FAB → 「新建专辑」，支持任意层级的专辑嵌套。
- **ZIP 导入**：FAB → 「导入」选择 `.zip`，会自动解析并加入库根（散文件与 ZIP 走同一个入口）。
- **下载在线谱面**：选歌界面在线来源的卡片上有下载按钮，下载后成为本地曲目（`source: local`），可离线游玩、编辑。
- 同一首歌可以同时存在于多个专辑（共用 id），编辑 / 删除时会优先操作当前所在专辑的副本。

---

## 如何打包 ZIP 谱面包

ZIP 谱面包用于快速分享整张专辑或一套曲目。**两种格式都支持，推荐方式一**：

### 方式一：按文件夹结构打包（无需清单）

一个文件夹 = 一首歌，文件夹名即歌曲标题。整包解压后每个文件夹会自动成为一首歌曲（同名文件夹下的多个谱面文件 = 多个难度）：

```
我的专辑.zip
├── 歌曲A/
│   ├── 1.json            # 难度谱面（任意命名，按 metadata.difficulty 识别难度）
│   ├── 2.json
│   ├── cover.png         # 可选：封面
│   └── audio.mp3         # 可选：背景音乐（mp3/ogg/wav/m4a/aac/flac/webm）
└── 歌曲B/
    ├── chart.json        # 文件名随意
    └── song.ogg
```

导入规则：每个包含谱面文件（`.json` / `.chart`）的文件夹生成一首歌；难度名取自谱面内 `metadata.difficulty`（如 `"Hard Lv.6"` → 名称 Hard、等级 6），未标注则回退为 `NORMAL`；音频 / 封面缺失时给出警告但照常导入（无音频仍可游玩，播放合成器音）。

### 方式二：带 beatmaps.json 清单打包

压缩包内放一个 `beatmaps.json`（结构见[在线谱面服务器](#搭建在线谱面服务器)），其中 `cover` / `audio` / `chartFile` 等引用写**包内相对路径**，导入时会按路径自动把文件写入本地库。适合精确控制专辑层级、嵌套专辑与排序。

> 限制：单个压缩包上限 600MB；单次最多 200 首歌；空文件夹 / 无谱面文件夹会被跳过并提示。

---

## 添加自己的谱面 / 封面 / 音乐（beatmaps）

除了用「上传」按钮逐个导入，你也可以在项目里维护一个 **`beatmaps/` 内容目录**，把所有专辑、歌曲、音频、封面集中管理，再用脚本一键生成选歌索引。这部分内容**默认不随仓库提交**（已在 `.gitignore` 中忽略），需要你在本地自行创建。

> 仓库里只保留了「游戏核心代码 + 硬编码内置示范谱面」。你自己的谱面、音频、封面属于个人内容，按下面方式自行添加即可，不影响代码更新。

### 1. 创建目录结构

在项目根目录新建 `beatmaps/`，按「专辑 / 歌曲」两级组织：

```
beatmaps/
├── 我的专辑A/                 # 专辑文件夹（名字即专辑标题，空格用下划线 _）
│   ├── cover.jpg             # 可选：专辑封面（jpg）
│   ├── 歌曲一/               # 歌曲文件夹
│   │   ├── 1.json            # 难度谱面（文件名数字 = 难度顺序，见下）
│   │   ├── 2.json
│   │   ├── cover.jpg         # 可选：歌曲封面（优先于专辑封面取色）
│   │   └── audio.mp3         # 背景音乐（见下命名约定）
│   └── 歌曲二/
│       ├── 1.json
│       └── base.mp3
└── 我的专辑B/
    └── ...
```

**命名约定：**

- **难度文件**：命名为 `1.json`、`2.json`、`3.json`…（从 1 开始的数字）。脚本按数字从小到大映射为难度档位：
  `1→Easy`、`2→Normal`、`3→Hard`、`4→Insane`、`5→Another`。若谱面 `metadata.difficulty` 里写了名字（如 `"Hard Lv.7"`），则以谱面内写的为准。
- **音频文件**：优先识别 `base.mp3` / `audio.mp3` / `song.mp3`；若都不是，会取该目录下的任意 `.mp3`。
- **封面**：专辑级 `cover.jpg` 或歌曲级 `cover.jpg`（推荐 jpg）。脚本会**自动提取封面主色调**作为该专辑 / 歌曲的强调色（`accentColor`）；若没有 `node-vibrant` 或取色失败，则回退到谱面 `metadata.bgScheme.accentColor` 或默认色。

### 2. 编写 beatmaps.json 索引

如果你按照命名约定来管理谱面目录结构，**不需要手写** `beatmaps.json` —— 运行下面的脚本会根据 `beatmaps/` 目录自动生成 `public/beatmaps/beatmaps.json`：

```bash
node update-beatmaps.mjs
```

脚本会：

1. 扫描 `beatmaps/` 下所有专辑 / 歌曲 / 难度；
2. 自动从封面提取强调色写入 `accentColor`；
3. 生成 `public/beatmaps/beatmaps.json`（原有文件会先备份为带时间戳的 `beatmaps.backup_*.json`）；
4. 在终端打印扫描到的专辑 / 歌曲 / 难度清单，方便核对。

> 若想要封面取色功能，先 `npm install node-vibrant`（可选）。没装也能正常生成索引，只是不会自动取色。

生成的索引结构：

```jsonc
{
  "version": 1,
  "items": [
    {
      "type": "album",
      "id": "我的专辑a",
      "title": "我的专辑A",
      "artist": "Various Artists",
      "cover": "我的专辑A/cover.jpg",
      "accentColor": "#0ea5e9",
      "basePath": "我的专辑A",
      "songs": [
        {
          "type": "song",
          "id": "歌曲一",
          "title": "歌曲一",
          "artist": "Unknown",
          "bpm": 160,
          "cover": "我的专辑A/歌曲一/cover.jpg",
          "accentColor": "#3b82f6",
          "audio": "我的专辑A/歌曲一/audio.mp3",
          "basePath": "我的专辑A/歌曲一",
          "difficulties": [
            { "name": "Easy",   "level": 3, "chartFile": "我的专辑A/歌曲一/1.json" },
            { "name": "Normal", "level": 6, "chartFile": "我的专辑A/歌曲一/2.json" }
          ]
        }
      ]
    }
  ]
}
```

### 3. 让站点加载这些谱面

`public/beatmaps/` 在构建时会被原样复制到 `dist/beatmaps/`，选歌界面会读取其中的 `beatmaps.json` 自动列出你的专辑与歌曲。

```bash
node update-beatmaps.mjs   # 生成 / 更新索引
npm run build              # 构建，public/beatmaps 会进入 dist/
npm run preview            # 本地预览，确认专辑已出现
```

> 注意：因为 `beatmaps/` 与 `public/beatmaps/` 都默认被 `.gitignore` 忽略，它们**不会上传到远程仓库**。请自行备份这些个人内容，或在自己的私有仓库 / 网盘里管理。

---

## 搭建在线谱面服务器

除了导入到本地，你也可以把谱面放在任意 HTTP 服务器上，让游戏作为**在线来源**加载（可多人共享、无需各自导入）。游戏会同时展示「内置 + 在线 + 本地」三类谱面。

### 服务器目录结构

一个「在线谱面服务器」就是一个托管着 `beatmaps.json` 索引的目录。游戏会依次尝试请求：

1. `<服务器地址>/beatmaps.json`
2. `<服务器地址>/manifest.json`
3. 直接把服务器地址当作索引 URL（全路径清单）

索引内容为「专辑 / 歌曲 / 难度」的树形结构，所有 `cover` / `audio` / `chartFile` 引用都写成**相对该目录的路径**：

```jsonc
{
  "version": 1,
  "items": [
    {
      "type": "album",
      "id": "album-a",
      "title": "我的专辑",
      "cover": "album-a/cover.jpg",        // 相对服务器目录
      "accentColor": "#0ea5e9",
      "songs": [
        {
          "type": "song",
          "id": "song-1",
          "title": "歌曲一",
          "artist": "作者",
          "bpm": 160,
          "cover": "album-a/song-1/cover.jpg",
          "audio": "album-a/song-1/audio.mp3",
          "difficulties": [
            { "name": "Hard", "level": 6, "chartFile": "album-a/song-1/hard.json", "noteCount": 800 }
          ]
        }
      ]
    }
  ]
}
```

- `items` 可以是专辑 / 歌曲的混合列表，`album` 支持任意嵌套。
- `difficulties[].level` 为可选：不写则不显示难度等级。
- 结构不规则（缺字段 / 损坏）时会被安全规整，绝不导致崩溃。

### 快速搭建示例

**方案 A：静态托管（最简单）** — 把上述 `beatmaps.json` 与对应文件放到任意静态服务器（Nginx、GitHub Pages、对象存储等）的某个目录下，目录 URL 就是服务器地址。

**方案 B：复用本仓库脚本** — 在项目根目录维护 `beatmaps/` 内容目录（结构见上一节），运行：

```bash
node update-beatmaps.mjs   # 生成 public/beatmaps/beatmaps.json
npm run build && npm run preview
```

部署后 `https://你的域名/beatmaps` 即成为一台在线谱面服务器（这也是游戏内置的「本机服务器」默认指向）。

### 在游戏里添加服务器

设置 → **网络**，可添加 / 编辑 / 删除服务器：

- **标签**：显示名称。
- **地址（baseUrl）**：上述目录的 URL，游戏会自动追加 `/beatmaps.json` / `/manifest.json` 探测。
- 内置的「本机服务器」固定指向当前部署站点的 `/beatmaps`，不可删除，但可切换到其它服务器。

> 提示：服务器地址可以是 `https://` 或 `http://`。**在线来源的曲目可一键「下载」为本地曲目**，之后离线也能玩。若服务器跨域，请确保服务器返回正确的 CORS 响应头。

---

## 谱面编辑器

点击选歌界面的 **编辑器** 进入。编辑器分两种视图，可在顶部「视图」栏切换：

- **3D 视图**：立体轨道下落，贴近实际游玩手感。
- **2D 视图**：平面铺开的编辑网格，便于精细摆放，可调「竖线数」与「横线间距」。

### 快速制谱（手势识别）

在 3D 视图下选择 **快速制谱** 工具，直接用鼠标 / 手指在屏幕上操作即可，**全程不会弹出编辑框、不会选中已有音符**：

| 操作 | 结果 |
| --- | --- |
| 轻点一下马上松开 | 放下一个 **Tap** |
| 按住约 1 拍且基本不动 | 自动识别为 **Slide**，从按下位置起每过 1 拍生成一个节点，并跟随手指轨迹 |
| 按住后快速划动 | 自动识别为 **Touch**，沿手指划过的轨迹按吸附间隔生成一串音符 |

- **Slide / Touch 的判定只看「按下后第一拍」的位移**：第一拍内手指基本没动 → Slide；第一拍内划开 → Touch，之后不再更改。
- 所有音符都会按当前**吸附网格**（如 1/4 拍）摆放，可在编辑器里调整吸附精度（最小 1/16 拍）。
- 支持**多点触控**：多根手指可同时各自制谱。

### 其他编辑操作

- 滚轮 / 触屏上下滑动：在谱面中前后拖动播放头。
- 拖拽已有音符：移动其时间 / 位置（保留原始 y 值）。
- 空白处拖拽：仅滚动播放头，不会放置音符。

---

## 编辑器放置规则（DSL）

编辑器的「**放置规则**」面板允许你用一段小脚本，在**放置新音符时自动改写**音符属性（例如自动配色、自动方向等）。规则只对新放置的音符生效，之后手动改动不受影响；规则仅存于本地浏览器（localStorage），不会写入谱面 JSON。

### 语法

每行一条规则，从上往下依次执行：

```
<条件表达式> : <赋值1>, <赋值2>, ...
```

条件为真时，依序执行冒号后的赋值（用逗号分隔）。支持注释（`//` 或 `#` 开头）与空行。

**可用的音符属性**（可读可写）：`beat`、`x`、`y`、`type`（`tap` / `touch` / `slide`）、`color`、`angle`、`easing`。

**运算符**（类 JS 优先级）：`||` `&&` `==` `!=` `<` `>` `<=` `>=` `+` `-` `*` `/` `%` `!` `-`（负号）、括号，以及字符串字面量 `"..."` / `'...'`。

**内置函数**：`abs`、`sign`、`floor`、`ceil`、`round`、`sqrt`、`fract`（取小数部分 → [0,1)）、`near(a,b,tol?)`（带容差相等，默认 `1e-6`，用于浮点吸附比较）、`min`、`max`、`clamp(x,lo,hi)`。

### 示例

```
# 奇数拍上自动标红
beat % 2 == 1 : color = "#ff0000"

# 半拍对齐时给 1/2 拍位置的音符调角度
beat % 0.5 == 0 : angle = 45

# 左上区域的音符镜像到右侧对称位置
x < 0 && y < 0 : angle = -(x + y) * 23

# 按放置位置着色
x < -1.5 : color = "#00ff88"
y > 1 : color = "#ff8800"
```

面板下方会实时显示**按行号的语法 / 语义错误**（如未知属性、未知函数），有错的行在放置时会被静默跳过，不会中断制谱。

---

## 如何部署

该项目是纯前端项目，构建产物为静态文件，几乎可托管到任何地方。

### 1. 构建

```bash
npm run build     # 产物输出到 dist/
```

### 2. 静态托管（推荐）

把 `dist/` 目录整体上传到任意静态服务器即可：

- **Nginx / OpenResty / Apache**：将 `dist/` 作为网站根目录。
- **GitHub Pages / Vercel / Netlify / Cloudflare Pages / 对象存储**：直接关联仓库或拖拽上传 `dist/`。

> 默认 `base` 为相对路径 `./`，放在域名根目录或子目录都能正常加载。若部署到子目录（如 `https://域名/poly/`），把 `vite.config.ts` 里的 `base` 改为 `'/poly/'` 再重新构建即可。

### 3. 打包安卓 App（Capacitor）

使用 Capacitor，可将同一套 Web 代码打包成安卓应用：

```bash
npm run build
npx cap sync android      # 把 dist/ 同步进安卓工程
npx cap open android      # 用 Android Studio 打开并构建 / 运行
```

### 4. Lite 版与回退

项目内置 **Lite 版**（精简 / 兼容回退逻辑），用于低性能设备、部分旧版浏览器，或网络受限场景。当主资源（如外部谱面、音频）加载失败时，游戏会自动回退到代码内**硬编码的内置示范谱面**与**合成器音效**，保证始终可玩。

---

## 作为 PWA 安装 / 离线可用

项目已通过 `vite-plugin-pwa` 接入 Progressive Web App：**构建后自动生成 `manifest.webmanifest` 与 Service Worker（`sw.js`），全版本与 Lite 版均可「添加到主屏幕」并离线打开。**

### 构建后你会看到

```
dist/
├── manifest.webmanifest   # PWA 清单（名称、图标、主题色、start_url）
├── sw.js                  # Service Worker（由 workbox 生成）
├── registerSW.js          # SW 注册脚本（已自动注入到 index.html 与 lite/index.html）
├── icons/                 # PWA 图标（icon.svg / icon-maskable.svg）
└── ...
```

### 部署注意

1. **必须用 HTTPS（或 localhost）**：PWA 仅在安全上下文下生效，否则「安装」按钮不会出现。
2. **根目录部署**：默认 `base: './'`，`start_url` / `scope` 均为相对路径，直接把 `dist/` 挂到站点根即可，无需额外配置。
3. **子目录部署**（如 `https://域名/poluxis/`）：只需把 `vite.config.ts` 的 `base` 改成 `'/poluxis/'`，其余 PWA 配置（manifest 路径、SW 注册路径、scope）都会被插件按 `base` 自动处理，**无需逐处手动加前缀**。Lite 版的 manifest / SW 引用已使用相对路径（`../manifest.webmanifest`、`../registerSW.js`），在 `/poluxis/lite/` 下会正确指向 `/poluxis/`。
4. **服务器需正确返回 `sw.js` / `manifest.webmanifest`**（MIME：`application/manifest+json`、`text/javascript`），且对这两个文件不要强缓存（便于更新）。

### 缓存策略

- **应用外壳**（JS / CSS / HTML / 字体 / 图标）走 workbox **预缓存**，离线可打开。
- **谱面 `beatmaps/`、音效 `sounds/`** 为可选外部内容且体积可能较大，走 **运行时缓存**（`CacheFirst`，最多保留 200 / 50 条，30 天），不会一次性塞进预缓存。

### 替换为你自己的图标

当前 `public/icons/` 下是占位 SVG（`icon.svg` 标准图标、`icon-maskable.svg` 带安全边距的满版图标，用于不同设备的遮罩裁剪）。正式发布前建议替换为你的设计：

- 想用 PNG：在 `public/icons/` 放 `icon-192.png` / `icon-512.png` / `icon-512-maskable.png`，并在 `vite.config.ts` 的 `manifest.icons` 里把 `src` / `type: 'image/png'` / `sizes` 改对应值即可（SVG 在部分旧安卓上支持有限，PNG 兼容性最好）。

---

## 自定义皮肤

游戏支持用 **ZIP 皮肤包**替换音符外观（Tap / Touch / Slide 的音符本体与投影引导）。未选择皮肤包时使用内置默认外观（纯色描边，可微调内框 / 外框 / 判定框粗细）。导入与选择入口在 **设置 → 皮肤**。

### 皮肤包结构

一个皮肤包是 `.zip` 压缩包，内含一份 `skin.json` 清单 + 若干图片：

```
我的皮肤.zip
├── skin.json
├── tap.png          # 音符本体贴图（可选）
├── touch.png        # （可选）
├── slide.png        # （可选）
├── projTap.png      # 投影引导贴图（可选，按类型）
├── preview.jpg      # 设置界面展示用预览图（可选）
└── ...
```

`skin.json` 格式：

```jsonc
{
  "name": "我的皮肤",           // 必填
  "author": "作者",             // 可选
  "preview": "preview.jpg",     // 可选：zip 内相对路径
  "maps": {
    "tap": "tap.png",           // 可选
    "touch": "touch.png",       // 可选
    "slide": "slide.png",       // 可选
    "projTap": "projTap.png",   // 可选：按音符类型的投影引导
    "projTouch": "projTouch.png",
    "projSlide": "projSlide.png"
    // "projection": "guide.png"   // 旧版共享投影引导（无 per-type 时兜底）
  }
}
```

### 制作要点

- **图片必须是灰度 + 透明通道（alpha）**。运行时用音符的判定色给贴图着色（`颜色 × 贴图`），所以贴图本身的彩色会被忽略——用白色图形配 alpha 描边 / 填充最合适。
- 支持 `png / jpg / jpeg / webp / gif / bmp / svg`（SVG 会被栅格化后再着色）。
- `skin.json` 里引用的每个文件都必须存在于压缩包内，且文件路径与 `maps` / `preview` 里的相对路径一致；缺失会导入失败并提示缺哪个文件。
- 至少要有 `name` 与一个贴图映射，否则导入报错。
- 预览图 `preview` 也必须是包内文件，选填。

导入后点击皮肤卡片即可**设为当前皮肤**；删除皮肤会级联删除其引用的图片。任一贴图缺失 / 加载失败时，对应音符类型自动回退到默认纯色外观，不影响游玩。

---

## 自定义 UI 与打击音效（sounds）

游戏的命中音效、UI 点击音效默认由**代码内合成器**实时生成，开箱即用、无需任何音频文件。如果你想换成自己的音效，只需在 `public/sounds/` 目录放入对应的 `.ogg` 文件，构建后会被复制到 `dist/sounds/` 并自动加载。

> 同 `beatmaps/`，`public/sounds/` 默认被 `.gitignore` 忽略，**不会随仓库提交**（避免携带有版权的音频）。放入自己的音效文件即可，缺失时自动回退到合成器音效，游戏不会静音。

### 1. 音效文件约定

在 `public/sounds/` 下放置以下四个文件：

| 文件名 | 作用 | 触发时机 |
| --- | --- | --- |
| `tap.mp3` | Tap 命中音 | 点触音符命中时 |
| `touch.mp3` | Touch 命中音 | 连点音符命中时 |
| `slide.mp3` | Slide 命中音 | 滑条节点命中时 |
| `ui.mp3` | UI 交互音 | 按钮、卡片点击等界面操作 |

- 格式推荐 **`.mp3`**（兼容性好）；其他能被浏览器解码的格式也可，后缀名可以是ogg、mp3、m4a。
- 建议时长 **0.1 ~ 0.3 秒** 的短音，过长会与后续音符重叠、显得浑浊。
- 缺失任意一个文件时，该类型自动改用合成器音效兜底；放错文件名则不会被识别。

### 2. 让音效生效

```bash
# 把你的音效放到 public/sounds/ 后构建
npm run build
npm run preview   # 试听效果
```

只要 `public/sounds/tap.mp3` 等存在且能正常解码，就会**优先于合成器音效**播放。

### 3. 关于 UI 视觉风格

界面视觉（玻璃拟态、配色、字体 Orbitron 等）由 `src/index.css` 的 CSS 变量与 Tailwind 类定义。想微调主题色、模糊度、文字层级，优先改 `src/index.css` 顶部的 `--glass-*`、`--text-*` 等变量；想调整选歌界面标题、卡片样式，改 `src/components/SongSelect.tsx`。这些属于代码层自定义，改动后重新 `npm run build` 即可。

---

## 项目结构（简览）

```
.
├── index.html              # 应用入口
├── vite.config.ts          # 构建 / 部署配置（base、端口等）
├── capacitor.config.ts     # 安卓打包配置
├── src/
│   ├── App.tsx             # 顶层路由与状态
│   ├── components/
│   │   ├── GameCanvas.tsx      # 3D 游戏 / 快速制谱渲染
│   │   ├── Editor2DCanvas.tsx  # 2D 编辑器画布
│   │   ├── VisualChartEditor.tsx # 编辑器 UI 与手势
│   │   ├── SongSelect.tsx      # 选歌界面
│   │   ├── SettingsModal.tsx   # 设置（质量 / 皮肤 / 网络 / 语言 / 帮助）
│   │   ├── SkinManager.tsx     # 皮肤导入 / 选择 / 删除
│   │   ├── NetworkSettings.tsx # 在线谱面服务器管理
│   │   ├── filemgr/            # 文件管理器（本地库 / ZIP 导入 / 服务器）
│   │   └── ...
│   ├── data/
│   │   ├── demoCharts.ts       # 内置示范谱面（硬编码）
│   │   ├── libraryStore.ts     # 本地谱面库（IndexedDB）读写 / 增删改 / 移动
│   │   ├── zipImport.ts        # ZIP / 散文件谱面导入（fflate 解压）
│   │   ├── onlineServers.ts    # 在线谱面服务器列表与切换
│   │   ├── skinStore.ts        # 皮肤 ZIP 导入 / 贴图预加载
│   │   └── beatmapLoader.ts    # 清单装配（内置+在线+本地）与谱面加载
│   ├── utils/
│   │   ├── chartParser.ts      # 谱面 JSON 解析 / 校验 / 导出
│   │   └── editorRules.ts      # 编辑器“放置规则”DSL 解释器
│   └── audio/AudioManager.ts   # 音频与合成器音效
├── beatmaps/               # （可选）你的谱面 / 封面 / 音乐源目录，见上文
├── public/
│   ├── beatmaps/           # update-beatmaps.mjs 生成的索引（构建时进 dist/）
│   └── sounds/             # （可选）自定义 tap/touch/slide/ui.ogg 命中音效
├── update-beatmaps.mjs     # 扫描 beatmaps/ 生成 beatmaps.json 的脚本
└── dist/                   # 构建产物（需自己build，部署用）
```

> 运行所需的谱面、音频等「外部内容」为可选资源；缺失时由内置示范内容 / 合成器音效兜底。这些个人内容默认被 `.gitignore` 忽略，不会随仓库提交。

---

## 常见问题

**Q：导入谱面后没有声音？**
A：确认已同时导入音频文件，或在展开的曲目卡片上用「更换音频」绑定音频（库根独立曲目同样支持）。未绑定音频时仍可游玩，只是播放合成器音。

**Q：为什么 HTTP 访问（如 iOS Safari 用 IP 访问）时导入报 `crypto.subtle` 错误？**
A：`crypto.subtle` 仅在 HTTPS / localhost 等安全上下文可用。已做兼容：HTTP 下自动退化为「不去重」的普通存储，导入不受影响（只是相同文件不会去重）。如需完整能力，请用 HTTPS 部署。

**Q：放置规则写了没反应？**
A：放置规则只在**新放置音符**那一刻套用，已放下的音符不会被改写；且规则存于本地（localStorage），每个浏览器 / 设备需各自配置。面板下方会显示行号级错误，有错的行会被跳过。

**Q：皮肤导入失败 / 不生效？**
A：检查压缩包内是否含 `skin.json`（含 `name` 与至少一个 `maps` 键），且 `maps` / `preview` 引用的文件确实存在于包内且路径一致。图片应为**灰度 + 透明通道**，运行时会被判定色着色。未选择任何皮肤包时走默认纯色外观。

**Q：音符摆得不对齐 / 间隔太密？**
A：在编辑器里调大「吸附间隔」（如改为 1/4 拍）。吸附最小为 1/16 拍。

**Q：快速制谱总是识别成 Touch 而不是 Slide？**
A：Slide 要求「按下后第一拍内手指基本不动」。若第一拍就滑动，会被判定为 Touch。试着按住 1 拍再移动。

**Q：能多人 / 多指同时制谱吗？**
A：可以。编辑器支持多点触控，每根手指独立成一条轨迹。

---

## 许可证

本项目核心代码以MIT开源许可证的方式发布，欢迎学习、二次开发与分享。谱面、音频等外部内容请遵守各自作者的授权协议。
