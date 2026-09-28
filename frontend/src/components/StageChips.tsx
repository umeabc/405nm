import { Segmented } from 'antd';
import { stageColors, type StageKey } from '../theme';

/**
 * 作品状态筛选 chips。
 *
 * ⚠️ 这五档是**对外的聚合视图**，与内部状态机不是一一对应：
 *   翻译中 = sourced → translated（翻译未完成）
 *   校对中 = translated → proofread
 *   嵌字中 = proofread → typeset
 *   待发布 = typeset / publishable
 *   已发布 = published
 * 内部状态更细（见实施方案第七节），聚合只发生在展示层。
 */
export const STAGE_TABS: ReadonlyArray<{ key: StageKey | 'all'; label: string }> = [
  { key: 'all', label: '全部作品' },
  { key: 'translating', label: '翻译中' },
  { key: 'proofreading', label: '校对中' },
  { key: 'typesetting', label: '嵌字中' },
  { key: 'publishable', label: '待发布' },
  { key: 'published', label: '已发布' },
];

export type StageChipsProps = {
  value: StageKey | 'all';
  onChange: (value: StageKey | 'all') => void;
  /** 各档数量；缺省视为 0，显示成 `翻译中 2` 这种带计数的样式。 */
  counts?: Partial<Record<StageKey | 'all', number>>;
};

export function StageChips({ value, onChange, counts = {} }: StageChipsProps) {
  const options = STAGE_TABS.map((tab) => {
    const count = counts[tab.key] ?? 0;
    return {
      value: tab.key,
      label: count > 0 ? `${tab.label} ${count}` : tab.label,
    };
  });

  return (
    <Segmented
      value={value}
      onChange={(next) => onChange(next as StageKey | 'all')}
      options={options}
      style={{ background: '#FFFFFF' }}
    />
  );
}

/** 状态徽标用色统一从这里取，避免各处硬编码颜色。 */
export function stageColorOf(stage: StageKey): string {
  return stageColors[stage];
}
