import { EditOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Input, Modal, Select, Space, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, projectApi, workflowApi, type CreditSummary, type ProjectMemberRow } from '../api/client';
import { comiku } from '../theme';

/**
 * 署名栏。
 *
 * 显示的是**台账派生出来的字符串**，不是存在某一行上的自由文本 ——
 * 这是与参考实现最重要的一处结构差异（那边改个昵称要全库替换，
 * 覆盖一次就把历史抹了）。
 *
 * 编辑用「按角色整体替换」的语义：界面上这一栏是「翻译：甲、乙」，
 * 改完保存的结果就是它显示的样子。追加语义会让人删不掉人。
 */

export type CreditsBarProps = {
  fileId: string;
  canEdit: boolean;
  /** 作品 id：用来拉成员列表做选择 */
  projectId?: string;
  compact?: boolean;
};

const ROLE_ORDER = ['translator', 'proofreader', 'typesetter'] as const;
const ROLE_LABELS: Record<string, string> = { translator: '翻译', proofreader: '校对', typesetter: '嵌字' };

export function CreditsBar({ fileId, canEdit, projectId, compact = true }: CreditsBarProps) {
  const { message } = AntApp.useApp();
  const [summary, setSummary] = useState<CreditSummary>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [members, setMembers] = useState<ProjectMemberRow[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await workflowApi.credits(fileId);
      setSummary(res.summary);
    } catch {
      // 署名拉不到不该影响翻校主流程，静默即可。
    }
  }, [fileId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openEdit(role: string) {
    setEditing(role);
    setNames(summary[role]?.names ?? []);
    if (projectId && members.length === 0) {
      try {
        const res = await projectApi.members(projectId);
        setMembers(res.members);
      } catch {
        /* 拉不到成员就退化成纯手输 */
      }
    }
  }

  async function submit() {
    if (!editing) return;
    setSaving(true);
    try {
      const entries = names
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => {
          const member = members.find((m) => m.displayName === name || m.username === name);
          return member ? { userId: member.userId } : { displayName: name };
        });

      const res = await workflowApi.setCredits(fileId, editing, entries);
      setSummary(res.summary);
      setEditing(null);
      message.success('署名已更新');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const parts = ROLE_ORDER.map((role) => ({
    role,
    label: ROLE_LABELS[role]!,
    text: summary[role]?.text ?? '',
  })).filter((p) => p.text);

  return (
    <>
      <div className="nm-credits">
        <Space size={8} wrap>
          {parts.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              暂无署名
            </Typography.Text>
          ) : (
            parts.map((part) => (
              <Typography.Text key={part.role} style={{ fontSize: 12 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {part.label}
                </Typography.Text>{' '}
                {part.text}
              </Typography.Text>
            ))
          )}
        </Space>

        {canEdit ? (
          <Space size={2}>
            {ROLE_ORDER.map((role) => (
              <Tooltip key={role} title={`改${ROLE_LABELS[role]}署名`}>
                <Button size="small" type="text" icon={<EditOutlined />} onClick={() => void openEdit(role)} />
              </Tooltip>
            ))}
          </Space>
        ) : null}
      </div>

      {compact ? null : null}

      <Modal
        title={`改${ROLE_LABELS[editing ?? ''] ?? ''}署名`}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={() => void submit()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          这里是**整体替换**：保存后的结果就是这一栏显示的样子。
          顺序即显示顺序。不在站内的人可以直接输入名字。
        </Typography.Paragraph>
        <Select
          mode="tags"
          style={{ width: '100%' }}
          value={names}
          onChange={setNames}
          placeholder="选择成员，或直接输入名字后回车"
          options={members.map((m) => ({ value: m.displayName, label: `${m.displayName}（${m.roleName}）` }))}
          tokenSeparators={[',', '，', '、']}
        />
        <Input.TextArea
          style={{ marginTop: 8, display: 'none' }}
          value={names.join('、')}
          readOnly
        />
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8, color: comiku.inkSoft }}>
          提示：自动署名记的是「按下完成的人」。如果有人代按，在这里改成实际出力的人。
        </Typography.Text>
      </Modal>
    </>
  );
}
