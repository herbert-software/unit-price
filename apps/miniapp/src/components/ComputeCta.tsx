// 搜索无结果态的比价 CTA(主入口)。当搜索(q)在 board 返回零结果时呈现:把「没找到」
// 这一最高意图时刻转成「自己算它值不值」。点击 → navigateTo 比价表单页 pages/compute。
// 纯展示 + 一次导航;不发请求、不计算。
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';

import './ComputeCta.css';

export interface ComputeCtaProps {
  /** 解码后的搜索词(可选);有则在文案里点名,让「没搜到 X」更具体。 */
  term?: string;
}

export default function ComputeCta({ term }: ComputeCtaProps) {
  const go = () => {
    void Taro.navigateTo({ url: '/pages/compute/index' });
  };
  return (
    <View className="ccta">
      {/* 放大镜 + 斜杠(未找到)字形,primitive Views + currentColor,无图标字体 */}
      <View className="ccta__glyph">
        <View className="ccta__glyph-ring" />
        <View className="ccta__glyph-handle" />
        <View className="ccta__glyph-slash" />
      </View>
      <Text className="ccta__title">
        {term ? `没搜到「${term}」` : '没搜到这件商品？'}
      </Text>
      <Text className="ccta__hint">它可能还没收录。输入规格，当场算它的单价、看它在同类里排哪。</Text>
      <View className="ccta__btn" onClick={go}>
        <Text className="ccta__btn-t">输入规格，算它值不值</Text>
      </View>
    </View>
  );
}
