// 即时比价表单页 (pages/compute) — 结构化输入 → 确定性单价 + 在所选 cohort 内定位。
// 进入：榜单首页搜索无结果态 CTA(主) / 搜索框旁紧凑入口(辅)。非 Tab 页(带返回)。
//
// 只读边界:本页是一次性比价,NOT 录入到库/贡献/纠错;计算在服务端 /compute(无 AI、
// 不写库),端上不跑 core。本页 UI 只负责采集结构化字段、调 api-client、渲染结果。
//
// Transport: Taro.request (WeChat has no fetch). URL 由 api-client buildComputeUrl
// 构造、响应由 parseComputeResponse(jitless) 校验;请求/响应类型从 api-client 导入,
// miniapp 不手写重复类型也不绕过校验。品类列表从 GET /categories 派生(见 form.toCohorts),
// 禁硬编码(防漂移)。提交前的轻校验仅为减少空跑,权威校验在服务端。
import { View, Text, Input, Picker } from '@tarojs/components';
import type { BaseEventOrig } from '@tarojs/components';
import Taro, { useLoad } from '@tarojs/taro';
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  buildCategoriesUrl,
  parseCategoryTreeResponse,
  buildComputeUrl,
  parseComputeResponse,
  type ComputeRequest,
  type ComputeResult,
  type ComputeUnit,
} from '@unit-price/api-client';
import { BASE, BASE_IS_PLACEHOLDER } from '../index/config';
import RankingRow from '../../components/RankingRow';
import {
  toCohorts,
  unitsForAxis,
  isUnitOnAxis,
  axisCaption,
  buildComputeRequest,
  deriveResultView,
  type Cohort,
  type AmountMode,
} from './form';

import './index.css';

// 品类加载态(/categories 派生 cohort)。失败给降级态,勿白屏。
type CatPhase = 'loading' | 'ready' | 'error';
// 提交结果三态。
type ResultPhase = 'idle' | 'loading' | 'error' | 'result';

export default function Compute() {
  // — 品类(从 /categories 派生,禁硬编码)—
  const [catPhase, setCatPhase] = useState<CatPhase>('loading');
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [cohortIdx, setCohortIdx] = useState(0);

  // — 表单字段 —
  const [totalPrice, setTotalPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [mode, setMode] = useState<AmountMode>('unit');
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<ComputeUnit>('ml');
  const [hint, setHint] = useState('');

  // — 提交/结果三态 —
  const [resPhase, setResPhase] = useState<ResultPhase>('idle');
  const [result, setResult] = useState<ComputeResult | null>(null);
  const [errMsg, setErrMsg] = useState('');
  const [showFormula, setShowFormula] = useState(false);

  const loadCohorts = () => {
    setCatPhase('loading');
    fetchCohorts()
      .then((cs) => {
        setCohorts(cs);
        setCohortIdx(0);
        // 单位随首个 cohort 的轴预约束。
        if (cs.length > 0) setUnit(unitsForAxis(cs[0].axis)[0]);
        setCatPhase('ready');
      })
      .catch(() => setCatPhase('error'));
  };

  useLoad(() => {
    loadCohorts();
  });

  const cohort: Cohort | undefined = cohorts[cohortIdx];
  // 单位选项随所选品类的可比单位轴约束(per_100ml→ml/L、per_100g→g/kg)。
  const units = cohort ? unitsForAxis(cohort.axis) : unitsForAxis('per_100ml');
  // 切到不在本轴的单位时纠回(端上预约束,与服务端跨轴 400 同口径)。
  const safeUnit: ComputeUnit = cohort && isUnitOnAxis(unit, cohort.axis) ? unit : units[0];

  const onPickCohort = (e: BaseEventOrig<{ value: number | string }>) => {
    const i = Number(e.detail.value);
    setCohortIdx(i);
    const next = cohorts[i];
    if (next && !isUnitOnAxis(unit, next.axis)) setUnit(unitsForAxis(next.axis)[0]);
    setResult(null);
    setResPhase('idle');
  };

  const onSubmit = async () => {
    // 端上轻校验 + ComputeRequest 组装(纯函数)。ok:false → 行内提示,不发请求。
    const built = buildComputeRequest({
      totalPrice, quantity, mode, amount, unit: safeUnit, cohort,
    });
    if (!built.ok) {
      setHint(built.hint);
      return; // 空 / 非法输入禁止发起请求
    }
    setHint('');
    setResPhase('loading');
    try {
      const r = await postCompute(built.request);
      setResult(r);
      setShowFormula(false);
      setResPhase('result');
    } catch (e) {
      // Surface the server's specific 400 message (axis mismatch / 未知品类 /
      // per_100g 不支持 / 输入集不足) rather than a generic failure string.
      setResult(null);
      setErrMsg(e instanceof Error && e.message ? e.message : '计算失败，请检查输入或稍后重试');
      setResPhase('error');
    }
  };

  if (catPhase === 'loading') {
    return (
      <View className="screen cscreen">
        <StateCard hint="加载品类中…" />
      </View>
    );
  }
  if (catPhase === 'error') {
    return (
      <View className="screen cscreen">
        <StateCard hint="品类加载失败" sub="点击重试" onTap={loadCohorts} />
      </View>
    );
  }
  if (cohorts.length === 0) {
    return (
      <View className="screen cscreen">
        <StateCard hint="暂无可比品类" sub="数据准备中" />
      </View>
    );
  }

  const pending = resPhase === 'loading';

  return (
    <View className="screen cscreen">
      <View className="cintro">
        <Text className="cintro__title">这件值不值？</Text>
        <Text className="cintro__sub">输入规格，算它的单价、看它在同类里排哪</Text>
      </View>

      <View className="cform">
        <FieldRow label="品类">
          <Picker mode="selector" range={cohorts.map((c) => c.name)} value={cohortIdx} onChange={onPickCohort}>
            <View className="cpick">
              <Text className="cpick__val">{cohort ? cohort.name : '选择品类'}</Text>
              <View className="cpick__caret" />
            </View>
          </Picker>
        </FieldRow>

        <FieldRow label="总价">
          <View className="cmoney">
            <Text className="cmoney__yuan">¥</Text>
            <Input
              className="cinput cinput--money"
              type="digit"
              placeholder="0.00"
              placeholderClass="cph"
              value={totalPrice}
              onInput={(e) => setTotalPrice(e.detail.value)}
            />
          </View>
        </FieldRow>

        {/* 二选一:按单件容量(需数量) / 按总容量 */}
        <View className="cseg">
          <View
            className={mode === 'unit' ? 'cseg__opt cseg__opt--on' : 'cseg__opt'}
            onClick={() => { setMode('unit'); setResult(null); setResPhase('idle'); }}
          >
            <Text className="cseg__t">按单件容量</Text>
          </View>
          <View
            className={mode === 'total' ? 'cseg__opt cseg__opt--on' : 'cseg__opt'}
            onClick={() => { setMode('total'); setResult(null); setResPhase('idle'); }}
          >
            <Text className="cseg__t">按总容量</Text>
          </View>
        </View>

        {mode === 'unit' ? (
          <FieldRow label="数量">
            <View className="cqty">
              <Input
                className="cinput"
                type="number"
                placeholder="1"
                placeholderClass="cph"
                value={quantity}
                onInput={(e) => setQuantity(e.detail.value)}
              />
              <Text className="cqty__unit">件</Text>
            </View>
          </FieldRow>
        ) : null}

        <FieldRow label={mode === 'unit' ? '单件容量' : '总容量'}>
          <View className="camount">
            <Input
              className="cinput"
              type="digit"
              placeholder={mode === 'unit' ? '如 330' : '如 7920'}
              placeholderClass="cph"
              value={amount}
              onInput={(e) => setAmount(e.detail.value)}
            />
            <View className="cunits">
              {units.map((u) => (
                <View
                  key={u}
                  className={u === safeUnit ? 'cunit cunit--on' : 'cunit'}
                  onClick={() => setUnit(u)}
                >
                  <Text className="cunit__t">{u}</Text>
                </View>
              ))}
            </View>
          </View>
        </FieldRow>

        {/* 比价口径提示:选了 per_100ml cohort 提示按每100ml、per_100g 提示按每100g。 */}
        {cohort ? <Text className="cform__cap">{axisCaption(cohort.axis)}</Text> : null}

        {hint ? <Text className="cform__hint">{hint}</Text> : null}
      </View>

      {resPhase === 'error' ? (
        <View className="cres cres--err">
          <Text className="cres__errt">{errMsg || '计算失败，请检查输入或稍后重试'}</Text>
        </View>
      ) : null}

      {resPhase === 'result' && result ? (
        <ResultCard
          result={result}
          cohortName={cohort ? cohort.name : ''}
          showFormula={showFormula}
          onToggleFormula={() => setShowFormula((v) => !v)}
        />
      ) : null}

      {/* 底部主操作 */}
      <View className="cbar">
        <View className={pending ? 'cbtn cbtn--busy' : 'cbtn'} onClick={pending ? undefined : onSubmit}>
          <Text className="cbtn__t">{pending ? '计算中…' : '算它值不值'}</Text>
        </View>
      </View>
    </View>
  );
}

/** Loading / error / empty card — reuses the 分类 Tab's .placeholder design. */
function StateCard(props: { hint: string; sub?: string; onTap?: () => void }) {
  return (
    <View className="placeholder">
      <View className="placeholder__card" onClick={props.onTap}>
        <Text className="placeholder__title">即时比价</Text>
        <Text className="placeholder__hint">{props.hint}</Text>
        {props.sub ? <Text className="placeholder__sub">{props.sub}</Text> : null}
      </View>
    </View>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="cfield">
      <Text className="cfield__label">{label}</Text>
      <View className="cfield__ctrl">{children}</View>
    </View>
  );
}

function ResultCard({
  result,
  cohortName,
  showFormula,
  onToggleFormula,
}: {
  result: ComputeResult;
  cohortName: string;
  showFormula: boolean;
  onToggleFormula: () => void;
}) {
  const per = result.axis === 'per_100g' ? result.per100g : result.per100ml;
  const unitLabel = result.axis === 'per_100g' ? '元/100g' : '元/100ml';
  // 裁决 / 「比 X% 便宜」/ 位置点全部来自 deriveResultView(纯函数、单测覆盖);卡片只渲染。
  // empty(total=0)→ verdict 'empty'(无 --worth/--pricey/--mid 修饰 → 中性观感、不下结论)。
  const { empty, verdict, cheaperPct, pos } = deriveResultView(result);

  return (
    <View className="cres">
      {cohortName ? <Text className="cres__cohort">{cohortName}</Text> : null}
      <View className={`cres__hero cres__hero--${verdict}`}>
        <View className="cres__perwrap">
          <Text className="cres__per">{per != null ? per.toFixed(2) : '—'}</Text>
          <Text className="cres__perunit">{unitLabel}</Text>
        </View>
        <Text className={`cres__verdict cres__verdict--${verdict}`}>
          {empty
            ? '暂无同类可比'
            : verdict === 'worth'
              ? `比同类 ${cheaperPct}% 便宜，挺值`
              : verdict === 'pricey'
                ? `比同类便宜的只有 ${cheaperPct}%，偏贵`
                : `居中，比 ${cheaperPct}% 同类便宜`}
        </Text>
      </View>

      {/* 位置条:左=便宜 右=贵,标记在用户位置。无同类(total=0)时不显示。 */}
      {!empty ? (
        <View className="cbarviz">
          <View className="cbarviz__track">
            <View className={`cbarviz__dot cbarviz__dot--${verdict}`} style={`left:${(pos * 100).toFixed(1)}%`} />
          </View>
          <View className="cbarviz__ends">
            <Text className="cbarviz__end">便宜</Text>
            <Text className="cbarviz__rank">
              {result.rank > result.total ? `比全部 ${result.total} 个同类都贵` : `共 ${result.total} 个同类`}
            </Text>
            <Text className="cbarviz__end">贵</Text>
          </View>
        </View>
      ) : null}

      {/* 计算留痕:可展开 formula */}
      <View className="cres__formula" onClick={onToggleFormula}>
        <Text className="cres__formula-h">{showFormula ? '收起算式' : '看怎么算的'}</Text>
        {showFormula ? <Text className="cres__formula-b">{result.formula}</Text> : null}
      </View>

      {result.neighbors.length > 0 ? (
        <View className="cres__near">
          <Text className="cres__near-h">最接近的同类</Text>
          {result.neighbors.map((it) => (
            <RankingRow key={`${it.store}:${it.storeSku}:${it.rank}`} item={it} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ————————————————————————————————————————————————————————————————
// Transport (Taro.request). URL 由 api-client builder 构造、响应由其 parser(jitless)
// 校验;miniapp 不手写类型也不绕过校验。BASE 复用 pages/index/config(prod 直连)。

/** One validated GET /categories fetch → derived leaf cohorts. Throws on network
 *  OR schema failure (parseCategoryTreeResponse fail-closed) — caught into the
 *  品类 error state. */
async function fetchCohorts(): Promise<Cohort[]> {
  if (BASE_IS_PLACEHOLDER) {
    throw new Error('BASE 未配置：见 src/pages/index/config.ts');
  }
  const res = await Taro.request({ url: buildCategoriesUrl(BASE), method: 'GET' });
  return toCohorts(parseCategoryTreeResponse(res.data).nodes);
}

/** One validated POST /compute call. Throws on network OR schema failure OR a
 *  non-2xx the parser can't validate — caught into the result error state. */
async function postCompute(body: ComputeRequest): Promise<ComputeResult> {
  if (BASE_IS_PLACEHOLDER) {
    throw new Error('BASE 未配置：见 src/pages/index/config.ts');
  }
  const res = await Taro.request({
    url: buildComputeUrl(BASE),
    method: 'POST',
    data: body,
    header: { 'content-type': 'application/json' },
  });
  // Taro.request does NOT throw on 4xx. A non-200 carries the server's specific
  // error envelope ({ error, message }); surface its `message` so the user sees
  // the actionable reason (跨轴不可比 / 未知品类 / per_100g 不支持 / 输入集不足),
  // not a generic failure. Only a 200 body is contract-validated by the parser.
  if (res.statusCode !== 200) {
    const d = res.data as { message?: unknown } | null;
    const msg = d && typeof d.message === 'string' ? d.message : '计算失败，请稍后重试';
    throw new Error(msg);
  }
  // parseComputeResponse is fail-closed; a malformed 200 throws a raw ZodError whose
  // .message is an ugly JSON-ish string — map it to a clean user-facing message so
  // only the server's own 400 envelope text (thrown above) ever reaches the user verbatim.
  try {
    return parseComputeResponse(res.data);
  } catch {
    throw new Error('返回数据异常，请稍后重试');
  }
}
