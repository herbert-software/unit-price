## 为什么

对真实山姆 HAR(440 商品)校准发现:tier1 容量抽取 97.7%,但**数量召回仅 20.7%**(数量一旦抽到则 95.8% 正确——精度高、召回低)。低召回的主因不全是「需 LLM」,而是几类 tier1 本可处理却漏掉的真实标题模式:

- **单件大规格**:`MM 弱碱性饮用水 4L`、`星巴克能量饮料4.104升`——单件无 `*N`,数量其实=1,但 tier1 留 `quantity=null` → 判不可算。
- **数量前置于容量**:`阿尔卑斯山…FONTE LINDA 24x500mL`——数量在 size 之前,而上次 `X20` 修复把数量搜索限定在 size 之后,正好漏掉这类(48 条真值里的一处错例)。

补这几类纯解析召回(不动单位模型、不依赖 LLM),能把 tier1 完整率显著拉高。改进幅度由 `add-eval-harness` 的基线度量、保证不回退。

## 变更内容

仅提升 tier1 正则解析的**召回**,不改既有干净标题行为、不改 tier3/API:

- **孤立容量单件 → 数量 1**:当解析出容量 `unitSize`(`ml`/`L`)但标题无任何数量/乘号/包装计数时,视 `quantity = 1`、`totalAmount = unitSize`,使单件大规格可算。
- **数量前置提取(count-before-size)**:当数量乘号位于容量之前(`24x500mL`、`24×500mL`),也能正确抽出数量,同时**保持** size-anchored 对品名噪声(`可口可乐X20 330ml*6听` 的 `X20`)的免疫——即只在「紧贴 size 的前缀」识别前置数量,不吞品名里游离的 `X<数字>`。

## 非目标

- **饮料按重量计价(per-100g)**:真实数据有 `275克*12瓶`、`270g x15` 等按 `g/克` 标的果汁。支持它们需引入 per-100g 这一新可比单位(属 `bootstrap` 已声明的「其他单位口径留后续」),**本次不做**——这类继续走「确定不可计算」终态,留独立 change。
- 不改 tier2 LLM、tier3 calculator、`/parse` HTTP 语义、confidence 分档。
- 无数量信号且无 size 的纯品名(`Member's Mark 饮用天然水`)仍交 tier2,本次不处理。

## 功能 (Capabilities)

### 新增功能
本次为对既有 `spec-parsing` 的增量,无全新 capability。

### 修改功能
- `spec-parsing`: 新增两类 tier1 召回行为(孤立单件→数量1、数量前置提取),不改既有解析/计算/置信契约。

## 影响

- **代码**:`packages/core/src/parser.ts`(数量提取逻辑)+ `packages/core/src/parser.test.ts`(真实样本用例)。不动其他模块。
- **度量**:改进幅度对照 `add-eval-harness` 基线;数量召回应明显上升、精度不下降(真实 ground truth 回归)。
- **依赖/顺序**:本变更修改 `spec-parsing` 能力,基线规范由 `bootstrap-parse-skeleton` 提供——实现前应先归档 `bootstrap`(或同步其规范),使 `spec-parsing` 成为可叠加的基线;改进验证依赖 `add-eval-harness` 先就位。
- **合规敏感面**:无(纯本地解析逻辑改动)。
