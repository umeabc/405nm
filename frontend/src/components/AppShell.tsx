import { BulbOutlined, LogoutOutlined, MoonOutlined, TeamOutlined, ToolOutlined, UserOutlined } from '@ant-design/icons';
import { Avatar, Dropdown, Layout, Menu, Space, Typography } from 'antd';
import { useMemo, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useBranding } from '../hooks/useBranding';
import { palette } from '../theme';
import { NotificationBell } from './NotificationBell';

export type AppShellProps = {
  dark: boolean;
  onToggleDark: () => void;
  children: ReactNode;
};

function initialOf(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?';
}

export function AppShell({ dark, onToggleDark, children }: AppShellProps) {
  const { user, logout } = useAuth();
  const branding = useBranding();
  const navigate = useNavigate();
  const location = useLocation();

  const navItems = useMemo(() => {
    const items = [
      { key: '/', label: <Link to="/">工作台</Link> },
      { key: '/teams', label: <Link to="/teams">团队</Link> },
    ];
    // 后台入口只对站点管理员显示；接口层还有一道真实校验，这里只是不给无用入口。
    if (user?.isSiteAdmin) {
      items.push({ key: '/admin', label: <Link to="/admin">站点后台</Link> });
    }
    return items;
  }, [user?.isSiteAdmin]);

  const selectedKey = navItems
    .map((i) => i.key)
    .filter((key) => (key === '/' ? location.pathname === '/' : location.pathname.startsWith(key)))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <Layout style={{ minHeight: '100%' }}>
      <Layout.Header
        className="nm-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          borderBottom: `1px solid ${dark ? '#3A3230' : palette.border}`,
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: palette.primary }}>
            {branding.name}
          </span>
        </Link>

        <Menu
          mode="horizontal"
          selectedKeys={selectedKey ? [selectedKey] : []}
          items={navItems}
          style={{ flex: 1, borderBottom: 'none', background: 'transparent', minWidth: 0 }}
        />

        <Space size={4}>
          <NotificationBell />

          <Dropdown
            menu={{
              items: [
                {
                  key: 'profile',
                  icon: <UserOutlined />,
                  label: '个人资料',
                  onClick: () => navigate('/profile'),
                },
                {
                  key: 'dark',
                  icon: dark ? <BulbOutlined /> : <MoonOutlined />,
                  label: dark ? '切换到浅色' : '切换到暗色',
                  onClick: onToggleDark,
                },
                { type: 'divider' },
                {
                  key: 'logout',
                  icon: <LogoutOutlined />,
                  label: '退出登录',
                  onClick: () => {
                    void logout().then(() => navigate('/login', { replace: true }));
                  },
                },
              ],
            }}
            placement="bottomRight"
          >
            <Space style={{ cursor: 'pointer', padding: '0 4px' }} size={8}>
              <Avatar
                size={28}
                style={{ background: palette.primary, fontSize: 13 }}
                src={user?.avatarKey ?? undefined}
              >
                {user ? initialOf(user.displayName) : '?'}
              </Avatar>
              <Typography.Text className="nm-username" style={{ maxWidth: 120 }} ellipsis>
                {user?.displayName}
              </Typography.Text>
            </Space>
          </Dropdown>
        </Space>
      </Layout.Header>

      <Layout.Content>
        <div style={{ maxWidth: 1160, margin: '0 auto', padding: '28px 24px 48px' }}>{children}</div>
      </Layout.Content>
    </Layout>
  );
}

/** 页面标题 + 说明的统一排版，避免每页各写一套。 */
export function PageHeader({
  title,
  description,
  extra,
}: {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        gap: 16,
        marginBottom: 20,
        flexWrap: 'wrap',
      }}
    >
      <div>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          {title}
        </Typography.Title>
        {description ? (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {description}
          </Typography.Text>
        ) : null}
      </div>
      {extra}
    </div>
  );
}

/**
 * 彩翻风格的页面标题（对应它的 `ContentTitle`）：**18px 加粗、主色、下边距 15px**。
 *
 * 与 `PageHeader` 并存而不是二选一：`PageHeader` 是「页面名 + 说明」的通用排版，
 * 字号大、颜色中性；`ContentTitle` 是彩翻仪表盘的那种「一行主色标题」。
 * 目前只有工作台（首页）用它 —— 用户明确要求只有首页与登录页对齐彩翻，
 * 其余页面的标题保持原样。
 */
export function ContentTitle({
  title,
  description,
  extra,
}: {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        gap: 16,
        marginBottom: 15,
        flexWrap: 'wrap',
      }}
    >
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, color: palette.primary, lineHeight: 1.4 }}>
          {title}
        </div>
        {description ? (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {description}
          </Typography.Text>
        ) : null}
      </div>
      {extra}
    </div>
  );
}

/** 只在有权限时渲染子树 —— 界面层的便利，真正的判定在后端。 */
export function Can({ permissions, code, children }: { permissions: string[]; code: string; children: ReactNode }) {
  if (!permissions.includes(code)) return null;
  return <>{children}</>;
}

export { TeamOutlined, ToolOutlined };
