## 修改需求

### 需求:rankable 派生、归属变化必重算、且本期不接入 /rankings

`product.rankable` **必须**为派生值:当且仅当商品为**已分类(叶)**态且该叶解析出的 `comparable_unit` 非空(v1 = `per_100ml` 软饮)时为 `true`;待细化 / 待人工 / 酒类(`comparable_unit=null`)一律 `false`。本需求**只读** `rankable`、**不改其派生口径**。(标题「本期不接入 /rankings」一节保留自 P2 用于增量匹配,其内容已被 **P3(`add-category-tree-rankings`)取代**,见下「与 `/rankings` 的边界(P3 收敛)」。)

- **归属变化必重算**:所有写品类归属的路径(backfill / 挂叶 / 人工纠错)**必须**在写归属后**立即重算并更新 `rankable`**,**禁止**陈旧。
- **与 `/rankings` 的边界（P3 收敛，取代 P2「本期不接入」）**:`rankable` **现已接入** `GET /rankings` 与 `GET /categories`,成为品类作用域榜单的**权威「资格门」**。两套入榜判据(数据门「单价列非空」与资格门 `rankable`)在 P3 **收敛为合取**:某行入榜当且仅当「目标品类节点闭包成员 ∧ `rankable=true` ∧ `per100ml IS NOT NULL`」。`rankable` 回答「该不该上某可比轴」、数据门回答「是否真有该数」,**缺一不可**。**数据门的列由可排名成员(`rankable=true` 的商品)所在轴决定,而非由被查询节点自身的 `comparable_unit` 决定**——这关键在于被查询节点自身可无 `comparable_unit`(如 root `beverage` 为 null)但仍有可排名后代;v1 唯一可排名轴是 `per_100ml`(`rankable=true ⟹ 该商品 comparable_unit=per_100ml`),故**对任一节点(含 root)数据门一律 = `per100ml IS NOT NULL`**;v2 引入 `per_100g` 后跨多轴祖先节点需按成员各自轴取列(v2、非目标;详见 `rankings-api`)。因此:
  - 一个「待细化 / 待人工但 per100ml 可算」的软饮(`rankable=false`)**不再**出现在任何品类节点榜(含默认 root)——这与 P2「仍可能出现在扁平榜」的已知状态**已被收敛消除**;
  - 酒类叶(`comparable_unit=null` → `rankable=false`)即便有非空 per100ml 也**不入榜**(修正「按容量轴排序酒类」的语义错误),其品类节点榜经资格门**自然返回空**。
  - 详细 HTTP 契约(参数、错误码、闭包 JOIN、去重)见 `rankings-api` 与 `category-tree-api` 规范。

#### 场景:软饮叶且单位可算则 rankable
- **当** 商品为已分类软饮叶、继承 `comparable_unit=per_100ml`
- **那么** `rankable` **必须**为 `true`

#### 场景:酒类 / 待细化 / 待人工不可排名
- **当** 商品为酒类叶(`comparable_unit=null`)、或待细化、或待人工
- **那么** `rankable` **必须**为 `false`

#### 场景:归属改判后 rankable 必重算
- **当** 人工纠错或规则升级后再 backfill 使某商品归属改变
- **那么** 其 `rankable` **必须**随之重算到正确值,**禁止**保留旧派生值

#### 场景:rankable 已接入 /rankings、两套判据 P3 收敛
- **当** P3 后检查 `GET /rankings` 的入榜判据
- **那么** 它**必须**为「目标品类节点闭包成员 ∧ `rankable=true` ∧ `per100ml IS NOT NULL`」的合取(**已读** `rankable`);`rankable=false` 的项(待细化 / 待人工软饮、酒类)**禁止**出现在任何品类节点榜;P2 的「rankable 不接入、可算 per100ml 的待细化软饮仍入扁平榜」已不再成立
