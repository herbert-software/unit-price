## ADDED Requirements

### 需求:ingest/contribute 必须采集门店 native category id 作专用 provenance

`/ingest`、`/ingest/batch`、`/contribute` 的请求体**必须**支持一个**可空、专用**的门店原生品类字段 `nativeCategoryId`(山姆 `categoryIdList` 路径末端**叶 id** 字符串),作为**门店来源 provenance**(与 `store`/`storeSku`/`source`/`sourceUrl`/`capturedAt` 同层),用于打标签管线经 `store_category_map` 命中门店自身的叶级分类。

- **禁止复用 `categoryHint`**:`categoryHint` 是 `product.category`(粗 `'beverage'`)的透传源,塞 native-id 会污染领域列。`nativeCategoryId` **必须**是**独立字段**。
- **禁止进 core 领域 `RawProductSchema`**:native-id 是门店来源、非领域规格;领域 raw 仍只认 `title`/`price`/`categoryHint`。该字段在请求 envelope 的 provenance 层、随 `upsertRaw` 落 `product_raw.native_category_id`(见 `persistence`)。
- 校验语义:**显式 JSON `null` / 空串 / 纯空白均等同于省略** → 落 `null`、请求照常成功(**禁止**报 400);仅当传入**有意义的非空值**时 trim 后存储;非字符串(如数字)→ 400。即 schema **必须**先 preprocess 把 `null`/空白归为「省略」再 `min(1)`(裸 `z.string().trim().min(1).optional()` 会让空串/`null` 触发 400,与下方场景冲突,**禁止**)。
- 不改 `/contribute` 同步 200 契约、`/ingest` 202 异步契约、错误码集与现有 provenance COALESCE 语义;`nativeCategoryId` 只是**新增可空入参**,旧客户端不带它行为不变(**非** BREAKING)。

#### 场景:ingest 带 nativeCategoryId 落库供 store-map
- **当** 客户端 `POST /ingest`(或 `/contribute`/`/ingest/batch`)body 带 `nativeCategoryId: "10012164"`(山姆白酒叶 native id)
- **那么** 该值**必须**经 `upsertRaw` 写入 `product_raw.native_category_id`,**不得**写入 `categoryHint` 或 `product.category`;后台打标签时经 `store_category_map` 命中对应叶

#### 场景:省略 nativeCategoryId 退化为 tier1、不报错
- **当** 客户端不带 `nativeCategoryId`(或传空串 / 纯空白 / 显式 JSON `null`)
- **那么** `product_raw.native_category_id` 落 `null`,请求**必须**照常成功(契约不变,**不得**报 400);该商品分类仅走 tier1 关键词(store-map 不点火)

#### 场景:nativeCategoryId 不污染领域 category 列
- **当** 任意带 `nativeCategoryId` 的上报落库
- **那么** `product.category` **仍**由 `categoryHint` 透传(`'beverage'`),`nativeCategoryId` **禁止**改变 `product.category` 或 `categoryHint`
