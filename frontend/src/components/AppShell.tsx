import {
  AppstoreOutlined,
  BookOutlined,
  BulbOutlined,
  DownOutlined,
  LogoutOutlined,
  MoonOutlined,
  ReadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
  ToolOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Dropdown, Space, Typography } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useBranding } from '../hooks/useBranding';
import { teamApi, type TeamSummary } from '../api/client';
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
  const [teams, setTeams] = useState<TeamSummary[]>([]);

  useEffect(() => {
    void teamApi
      .mine()
      .then((res) => setTeams(res.teams))
      .catch(() => undefined);
  }, []);

  const currentTeam = teams[0];
  const teamInitial = (currentTeam?.name || '夏').trim().slice(0, 1);
  const teamTitle = currentTeam?.name || '主工作空间';
  const teamIntro = currentTeam?.intro || '一起把热爱变成作品';

  // 区分工作台与翻校工作台
  const isWorkbench = location.pathname.includes('/workbench/');

  // 面包屑推导
  let breadcrumbGroup = '工作空间';
  let breadcrumbPage = '工作台';
  if (location.pathname.startsWith('/teams')) {
    breadcrumbGroup = '工作空间';
    breadcrumbPage = location.pathname === '/teams' ? '团队与作品库' : '团队详情';
  } else if (location.pathname.includes('/workbench/')) {
    breadcrumbGroup = '工作空间';
    breadcrumbPage = '翻校工作台';
  } else if (location.pathname.startsWith('/projects/')) {
    breadcrumbGroup = '工作空间';
    breadcrumbPage = '作品详情';
  } else if (location.pathname.startsWith('/admin')) {
    breadcrumbGroup = '系统管理';
    breadcrumbPage = '站点后台';
  } else if (location.pathname.startsWith('/profile')) {
    breadcrumbGroup = '我的空间';
    breadcrumbPage = '个人资料';
  }

  const isHome = location.pathname === '/' && !location.search.includes('mine=1');
  const isMine = location.pathname === '/' && location.search.includes('mine=1');
  const isTeams = location.pathname.startsWith('/teams');
  const isAdmin = location.pathname.startsWith('/admin');
  const isProfile = location.pathname.startsWith('/profile');

  // 用户下拉菜单
  const userMenuItems = [
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
    { type: 'divider' as const },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      onClick: () => {
        void logout().then(() => navigate('/login', { replace: true }));
      },
    },
  ];

  return (
    <div className="cm-shell">
      {/* ── Comiku 风格左侧边栏 ────────────────────────────── */}
      <aside className="cm-app-sidebar">
        {/* 顶部 Logo 与品牌名 */}
        <Link to="/" className="cm-sidebar-brand">
          <div className="cm-sidebar-logo-icon">
            <BookOutlined />
          </div>
          <span className="cm-sidebar-brand-name">
            {branding.name || 'comiku'}
            <span className="cm-sidebar-brand-dot">.</span>
          </span>
        </Link>

        {/* 团队选择器卡片 */}
        <div className="cm-team-card" onClick={() => navigate('/teams')} title="点击查看所有团队">
          <div className="cm-team-badge">{teamInitial}</div>
          <div className="cm-team-info">
            <span className="cm-team-title">{teamTitle}</span>
            <span className="cm-team-sub">{teamIntro}</span>
          </div>
          <DownOutlined style={{ fontSize: 9, color: 'var(--nm-ink-soft)', flex: 'none' }} />
        </div>

        {/* 导航分组 1：工作空间 */}
        <div className="cm-nav-group">
          <div className="cm-nav-group-label">工作空间</div>

          <Link to="/" className={`cm-nav-item${isHome ? ' is-active' : ''}`}>
            <span className="cm-nav-item-left">
              <AppstoreOutlined style={{ fontSize: 15 }} />
              <span>工作台</span>
            </span>
          </Link>

          <Link to="/teams" className={`cm-nav-item${isTeams ? ' is-active' : ''}`}>
            <span className="cm-nav-item-left">
              <TeamOutlined style={{ fontSize: 15 }} />
              <span>团队与作品</span>
            </span>
            {teams.length > 0 && <span className="cm-nav-badge">{teams.length}</span>}
          </Link>

          {user?.isSiteAdmin && (
            <Link to="/admin" className={`cm-nav-item${isAdmin ? ' is-active' : ''}`}>
              <span className="cm-nav-item-left">
                <SafetyCertificateOutlined style={{ fontSize: 15 }} />
                <span>站点后台</span>
              </span>
            </Link>
          )}
        </div>

        {/* 导航分组 2：我的空间 */}
        <div className="cm-nav-group">
          <div className="cm-nav-group-label">我的空间</div>

          <Link to="/?mine=1" className={`cm-nav-item${isMine ? ' is-active' : ''}`}>
            <span className="cm-nav-item-left">
              <ReadOutlined style={{ fontSize: 15 }} />
              <span>我参与的作品</span>
            </span>
          </Link>

          <Link to="/profile" className={`cm-nav-item${isProfile ? ' is-active' : ''}`}>
            <span className="cm-nav-item-left">
              <UserOutlined style={{ fontSize: 15 }} />
              <span>个人资料</span>
            </span>
          </Link>
        </div>

        {/* 灵感名言卡片 */}
        <div className="cm-sidebar-quote">
          <div style={{ display: 'flex', gap: 4, marginBottom: 4, color: 'var(--nm-primary)' }}>
            <span>✦</span>
            <span style={{ opacity: 0.6 }}>✧</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--nm-ink-soft)', lineHeight: 1.5 }}>
            每一份热爱，都值得被看见。从第一句译文，到最后一页。
          </div>
        </div>

        {/* 底部功能区：外观与用户卡片 */}
        <div className="cm-sidebar-footer">
          <button type="button" className="cm-sidebar-pref-btn" onClick={onToggleDark}>
            {dark ? <BulbOutlined style={{ fontSize: 14 }} /> : <MoonOutlined style={{ fontSize: 14 }} />}
            <span>外观与偏好（{dark ? '暗色' : '浅色'}）</span>
          </button>

          <Dropdown menu={{ items: userMenuItems }} placement="topRight" trigger={['click']}>
            <div className="cm-sidebar-user-card">
              <Space size={8} align="center">
                <Avatar
                  size={32}
                  style={{
                    background: 'var(--nm-primary)',
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                  src={user?.avatarKey ?? undefined}
                >
                  {user ? initialOf(user.displayName) : '?'}
                </Avatar>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: 'var(--nm-ink)',
                      lineHeight: 1.3,
                      maxWidth: 110,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {user?.displayName}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--nm-ink-soft)', lineHeight: 1.2 }}>
                    {user?.isSiteAdmin ? '站点管理员' : '创作成份'}
                  </span>
                </div>
              </Space>
              <DownOutlined style={{ fontSize: 10, color: 'var(--nm-ink-soft)' }} />
            </div>
          </Dropdown>
        </div>
      </aside>

      {/* ── 主区域（顶部简练面包屑 + 内容） ────────────────────── */}
      <div className="cm-main-layout">
        <header className="cm-top-bar">
          <div className="cm-top-breadcrumb">
            <span>{breadcrumbGroup}</span>
            <span style={{ opacity: 0.4 }}>›</span>
            <span className="cm-top-breadcrumb-active">{breadcrumbPage}</span>
          </div>

          <div className="cm-top-bar-right">
            <span className="cm-status-tag-interactive">交互在线</span>
            <NotificationBell />
            <Avatar
              size={26}
              style={{
                background: 'var(--nm-primary)',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
              onClick={() => navigate('/profile')}
            >
              {user ? initialOf(user.displayName) : '?'}
            </Avatar>
          </div>
        </header>

        <main className={`cm-main-content${isWorkbench ? ' is-workbench' : ''}`}>{children}</main>
      </div>
    </div>
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

/** 彩翻/Comiku 风格的页面标题 */
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
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--nm-primary)', lineHeight: 1.4 }}>
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

/** 只在有权限时渲染子树 */
export function Can({
  permissions,
  code,
  children,
}: {
  permissions: string[];
  code: string;
  children: ReactNode;
}) {
  if (!permissions.includes(code)) return null;
  return <>{children}</>;
}

export { TeamOutlined, ToolOutlined, SettingOutlined };
