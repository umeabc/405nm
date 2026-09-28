import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, authApi, type PublicUser } from '../api/client';

type AuthState = {
  user: PublicUser | null;
  loading: boolean;
  /** 「问不到身份」——区别于「明确未登录」。见下方注释。 */
  unreachable: boolean;
  setUser: (user: PublicUser | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);

  /**
   * 区分两种失败：
   *  - 401 = 确实没登录（或会话过期）→ 清空身份，去登录页；
   *  - 其它（网络抖动、部署期间 502）→ **保留当前身份**，标记为「问不到」。
   *
   * 不区分的话，部署时重启容器这一瞬间访问站点的用户会被莫名踢回登录页 ——
   * 而他其实明明还登着。
   */
  const refresh = useCallback(async () => {
    try {
      const res = await authApi.me();
      setUser(res.user);
      setUnreachable(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        setUnreachable(false);
      } else {
        setUnreachable(true);
      }
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void authApi
      .me()
      .then((res) => {
        if (!alive) return;
        setUser(res.user);
        setUnreachable(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 401) {
          setUser(null);
          setUnreachable(false);
        } else {
          setUnreachable(true);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // 登出失败也把本地状态清掉，不要把人卡在登录态里。
    }
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, unreachable, setUser, refresh, logout }),
    [user, loading, unreachable, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
