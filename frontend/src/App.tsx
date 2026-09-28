import { App as AntApp, Button, ConfigProvider, Result, Spin } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import AdminPage from './pages/Admin';
import LoginPage from './pages/Login';
import ProfilePage from './pages/Profile';
import ProjectDetailPage from './pages/project';
import TranslatePage from './pages/translate';
import TeamDetailPage from './pages/TeamDetail';
import TeamsPage from './pages/Teams';
import WorkbenchPage from './pages/Workbench';
import { applyCssVariables, buildTheme, readStoredDark, THEME_STORAGE_KEY } from './theme';

/**
 * 登录态与路由的编排。
 *
 * 这里只是「不给无用入口」的界面层导流 —— 每个接口在后端都会再校验一次，
 * 前端跳转不构成任何安全保证。
 */
function Shell({ dark, onToggleDark }: { dark: boolean; onToggleDark: () => void }) {
  const { user, loading, unreachable, refresh } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="nm-centered">
        <Spin size="large" />
      </div>
    );
  }

  // 问不到身份 ≠ 未登录。此时不要把人踢去登录页，给一个重试入口 ——
  // 部署重启容器的那几秒里，用户不该被登出。
  if (unreachable && !user) {
    return (
      <div className="nm-centered">
        <Result
          status="warning"
          title="连接不上服务器"
          subTitle="可能是服务正在重启，稍等片刻再试。"
          extra={
            <Button type="primary" onClick={() => void refresh()}>
              重试
            </Button>
          }
        />
      </div>
    );
  }

  const atLogin = location.pathname === '/login';

  if (atLogin) {
    return user ? <Navigate to="/" replace /> : <LoginPage />;
  }

  if (!user) {
    // 记住原本要去哪儿，登录后送回去。
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return (
    <AppShell dark={dark} onToggleDark={onToggleDark}>
      <Routes>
        <Route path="/" element={<WorkbenchPage />} />
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/teams/:teamId" element={<TeamDetailPage />} />
        <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
        {/* 翻校工作台：一页一张图。fileId 放在路径里，浏览器前进后退与
            「复制链接给同事」都能直接落到同一页。 */}
        <Route path="/projects/:projectId/workbench/:fileId" element={<TranslatePage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

export default function App() {
  const [dark, setDark] = useState(readStoredDark);

  useEffect(() => {
    applyCssVariables(dark);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, dark ? 'dark' : 'light');
    } catch {
      // 隐私模式下写不了 localStorage，忽略即可，只是记不住偏好。
    }
  }, [dark]);

  return (
    <ConfigProvider locale={zhCN} theme={buildTheme(dark)}>
      <AntApp>
        <AuthProvider>
          <Shell dark={dark} onToggleDark={() => setDark((prev) => !prev)} />
        </AuthProvider>
      </AntApp>
    </ConfigProvider>
  );
}
