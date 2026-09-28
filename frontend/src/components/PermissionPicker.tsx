import { Checkbox, Typography } from 'antd';
import { Tooltip } from 'antd';
import type { PermissionInfo } from '../api/client';

/**
 * 权限勾选器。团队角色与作品角色共用一份实现。
 *
 * 之所以要共用：两边的规则完全一样（按功能分组、**不能授出自己没有的权限**），
 * 而这条规则一旦在某一处漏掉，界面就会给出一个「填得进去、存不下来」的表单，
 * 用户看到的只是一句 403，很难理解为界面本身的问题。
 */

const GROUP_LABELS: Record<string, string> = {
  team: '团队与成员',
  project: '作品',
  project_set: '作品集',
  term_bank: '术语库',
  term: '术语',
  quota: '额度',
  publish: '发布',
  file: '图片',
  label: '标号',
  tra: '翻译与校对',
  target: '目标语言',
};

function groupOf(code: string): string {
  return code.split('.')[0] ?? 'other';
}

/** 把权限目录按前缀分组，保持目录里的原始顺序。 */
export function groupPermissions(list: readonly PermissionInfo[]): Array<[string, PermissionInfo[]]> {
  const map = new Map<string, PermissionInfo[]>();
  for (const p of list) {
    const key = groupOf(p.code);
    map.set(key, [...(map.get(key) ?? []), p]);
  }
  return [...map.entries()];
}

export function PermissionPicker({
  groups,
  myPermissions,
  isSiteAdmin,
  value = [],
  onChange,
}: {
  groups: Array<[string, PermissionInfo[]]>;
  myPermissions: string[];
  isSiteAdmin: boolean;
  value?: string[];
  onChange?: (next: string[]) => void;
}) {
  return (
    <div>
      {groups.map(([group, items]) => (
        <div key={group} style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {GROUP_LABELS[group] ?? group}
          </Typography.Text>
          <div style={{ marginTop: 6 }}>
            <Checkbox.Group
              value={value}
              onChange={(next) => onChange?.(next as string[])}
              options={items.map((p) => ({
                label: (
                  <Tooltip title={p.code}>
                    <span>{p.label}</span>
                  </Tooltip>
                ),
                value: p.code,
                // 不能授出自己没有的权限 —— 与后端 assertRoleWithinActor 同一套规则。
                disabled: !isSiteAdmin && !myPermissions.includes(p.code),
              }))}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
