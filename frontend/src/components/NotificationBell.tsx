import { BellOutlined } from '@ant-design/icons';
import { Badge, Button, Empty, List, Popover, Segmented, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { notificationApi, noticeApi, type NoticeRow, type NotificationRow } from '../api/client';
import { comiku } from '../theme';
import { timeAgo } from '../utils/time';

/**
 * 通知铃铛。
 *
 * 这里合并**两种来源**，但刻意保持两栏、不合成一个列表：
 *  - 待办（`notificationApi`）：有人把图推进到了「该我接」的那一步；
 *  - 公告（`noticeApi`）：对所有人可见的广播。
 *
 * 不合并的理由是「已读」语义不同 —— 公告的已读是「这条我看过了」，
 * 待办的已读是「这件事我知悉/处理了」。混在一起，未读数就变成两套口径的叠加，
 * 那个数字不再说明任何事。
 *
 * 轮询节奏与参考实现一致：60 秒一次，页面不可见时跳过 ——
 * 后台标签页没人看，白耗请求没有意义。
 */
export function NotificationBell() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'todo' | 'notice'>('todo');
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [notices, setNotices] = useState<NoticeRow[]>([]);
  const [unreadTodo, setUnreadTodo] = useState(0);
  const [unreadNotice, setUnreadNotice] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [todo, notice] = await Promise.all([notificationApi.mine(), noticeApi.mine('all')]);
      setNotifications(todo.notifications.slice(0, 30));
      setUnreadTodo(todo.unread);
      setNotices(notice.notices.slice(0, 30));
      setUnreadNotice(notice.unread);
    } catch {
      // 通知拉取失败不该打扰用户，静默即可。
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function markAll() {
    setLoading(true);
    try {
      if (tab === 'todo') await notificationApi.markRead({ all: true });
      else await noticeApi.markRead({ all: true });
      await load();
    } finally {
      setLoading(false);
    }
  }

  /** 点待办：直接跳到那张图的翻校页 —— 通知的价值就在于「一步到位」。 */
  function openNotification(item: NotificationRow) {
    if (item.projectId && item.fileId) {
      navigate(`/projects/${item.projectId}/workbench/${item.fileId}`);
    } else if (item.projectId) {
      navigate(`/projects/${item.projectId}`);
    }
    setOpen(false);
  }

  const unread = unreadTodo + unreadNotice;
  const currentUnread = tab === 'todo' ? unreadTodo : unreadNotice;

  const content = (
    <div style={{ width: 360 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Segmented
          size="small"
          value={tab}
          onChange={(value) => setTab(value as 'todo' | 'notice')}
          options={[
            { label: unreadTodo > 0 ? `待办 ${unreadTodo}` : '待办', value: 'todo' },
            { label: unreadNotice > 0 ? `公告 ${unreadNotice}` : '公告', value: 'notice' },
          ]}
        />
        <Button size="small" type="link" disabled={currentUnread === 0} loading={loading} onClick={() => void markAll()}>
          全部已读
        </Button>
      </div>

      {tab === 'todo' ? (
        notifications.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有待办通知" />
        ) : (
          <List
            size="small"
            dataSource={notifications}
            style={{ maxHeight: 380, overflowY: 'auto' }}
            renderItem={(item) => (
              <List.Item
                style={{ padding: '8px 0', alignItems: 'flex-start', cursor: 'pointer' }}
                onClick={() => openNotification(item)}
              >
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space size={6}>
                    {!item.read ? (
                      <Tag color={comiku.primary} style={{ marginInlineEnd: 0 }}>
                        新
                      </Tag>
                    ) : null}
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {item.title}
                    </Typography.Text>
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                    {item.body}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {timeAgo(item.createdAt)}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )
      ) : notices.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有公告" />
      ) : (
        <List
          size="small"
          dataSource={notices}
          style={{ maxHeight: 380, overflowY: 'auto' }}
          renderItem={(item) => (
            <List.Item style={{ padding: '8px 0', alignItems: 'flex-start' }}>
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Space size={6}>
                  {!item.read ? (
                    <Tag color={comiku.primary} style={{ marginInlineEnd: 0 }}>
                      新
                    </Tag>
                  ) : null}
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {item.title || '公告'}
                  </Typography.Text>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                  {item.content.length > 120 ? `${item.content.slice(0, 120)}…` : item.content}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {timeAgo(item.createdAt)}
                </Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      )}
    </div>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // 打开面板时刷新一次：用户主动看，就给他最新的。
        if (next) void load();
      }}
    >
      <Badge count={unread} overflowCount={99} size="small" offset={[-2, 2]}>
        <Button type="text" icon={<BellOutlined />} aria-label="通知" />
      </Badge>
    </Popover>
  );
}
