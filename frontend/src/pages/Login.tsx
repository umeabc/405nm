import { LockOutlined, NumberOutlined, SmileOutlined, UserOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Form, Input, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, authApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useBranding } from '../hooks/useBranding';

type LoginForm = { username: string; password: string };
type RegisterForm = { username: string; password: string; displayName?: string; inviteCode: string };

/**
 * 登录 / 注册。
 *
 * 版式对齐彩翻（moeflow-irohamod）的 `pages/Login.tsx`：整屏左右分栏，
 * 左侧立绘 + 光环 + 站名标语，右侧一张 440px 的认证卡片。
 *
 * 与那边**不同**的两点，都是有意为之：
 *
 *  1. 那边登录页写死了浅色，暗色模式下打开会刺眼。这里全程走 CSS 变量。
 *  2. 那边的"忘记密码"是一句静态文案。这里保留同一个动作，但文案按
 *     「注册是否开放」切换 —— 405nm 是邀请码制，没码的人最该看到的是
 *     "去哪儿要码"，而不是"忘记密码找管理员"。
 */
export default function LoginPage() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { message } = AntApp.useApp();
  const branding = useBranding();

  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [submitting, setSubmitting] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);

  // 注册开关由后端决定（没有可用邀请码时就是关闭的），前端不猜。
  useEffect(() => {
    authApi
      .registrationStatus()
      .then((res) => setRegistrationOpen(res.open))
      .catch(() => setRegistrationOpen(false));
  }, []);

  // 后端说不能注册时，别把人留在注册页签上 —— 他填完整张表才会被拒。
  useEffect(() => {
    if (registrationOpen === false && tab === 'register') setTab('login');
  }, [registrationOpen, tab]);

  // ?next= 只接受站内相对路径，避免被当成开放跳转使。
  const nextParam = params.get('next');
  const nextPath = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';

  const finish = (user: Parameters<typeof setUser>[0]) => {
    setUser(user);
    navigate(nextPath, { replace: true });
  };

  async function handleLogin(values: LoginForm) {
    setSubmitting(true);
    try {
      const { user } = await authApi.login(values.username, values.password);
      finish(user);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegister(values: RegisterForm) {
    setSubmitting(true);
    try {
      const { user } = await authApi.register(values);
      message.success('注册成功，已自动登录');
      finish(user);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '注册失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  const loginForm = (
    <Form<LoginForm> layout="vertical" onFinish={handleLogin} requiredMark={false}>
      <Form.Item
        name="username"
        label="用户名或邮箱"
        extra="从旧站迁来的账号可以直接用原来的邮箱和密码登录"
        rules={[{ required: true, message: '请输入用户名或邮箱' }]}
      >
        <Input prefix={<UserOutlined />} placeholder="用户名或邮箱" autoComplete="username" size="large" />
      </Form.Item>

      <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="密码"
          autoComplete="current-password"
          size="large"
        />
      </Form.Item>

      <Button
        type="primary"
        htmlType="submit"
        block
        size="large"
        loading={submitting}
        style={{ height: 44, borderRadius: 10 }}
      >
        登录
      </Button>
    </Form>
  );

  const registerForm = (
    <Form<RegisterForm> layout="vertical" onFinish={handleRegister} requiredMark={false}>
      <Form.Item
        name="username"
        label="用户名"
        rules={[{ required: true, message: '请输入用户名' }]}
        extra="3 ~ 32 个字符，可用字母、数字、下划线、点、连字符或中文"
      >
        <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" size="large" />
      </Form.Item>

      <Form.Item name="displayName" label="昵称（可选）">
        <Input prefix={<SmileOutlined />} placeholder="展示用的名字，留空则与用户名相同" size="large" />
      </Form.Item>

      <Form.Item
        name="password"
        label="密码"
        rules={[{ required: true, message: '请输入密码' }]}
        extra="至少 8 位"
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="密码"
          autoComplete="new-password"
          size="large"
        />
      </Form.Item>

      <Form.Item
        name="inviteCode"
        label="邀请码"
        rules={[{ required: true, message: '请输入邀请码' }]}
        extra="向团队管理员索取"
      >
        <Input
          prefix={<NumberOutlined />}
          placeholder="XXXX-XXXX-XXXX"
          size="large"
          style={{ textTransform: 'uppercase' }}
        />
      </Form.Item>

      <Button
        type="primary"
        htmlType="submit"
        block
        size="large"
        loading={submitting}
        style={{ height: 44, borderRadius: 10 }}
      >
        注册并登录
      </Button>
    </Form>
  );

  const canRegister = registrationOpen === true;

  return (
    <div className="nm-login">
      {/* 窄于 900px 时整块隐藏（见 styles.css）：小屏上卡片本身就该占满，
          分栏只会把两边都挤窄。 */}
      <div className="nm-login-brand">
        <div className="nm-login-halo is-pink" />
        <div className="nm-login-halo is-gold" />

        {branding.mascotUrl ? (
          <img className="nm-login-mascot" src={branding.mascotUrl} alt="" />
        ) : (
          // 没配立绘时的兜底：一块同尺寸的字标。它同时充当光环的视觉锚点，
          // 所以尺寸与立绘一致 —— 否则光环会围着一片空气打转。
          <div className="nm-login-wordmark" aria-hidden>
            {branding.name}
          </div>
        )}

        <div className="nm-login-brand-text">
          <h1 className="nm-login-site-name">{branding.name}</h1>
          {branding.slogan ? <p className="nm-login-slogan">{branding.slogan}</p> : null}
        </div>
      </div>

      <div className="nm-login-main">
        <div className="nm-login-card">
          {canRegister ? (
            <div className="nm-login-switch" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'login'}
                className={tab === 'login' ? 'is-active' : ''}
                onClick={() => setTab('login')}
              >
                登录
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'register'}
                className={tab === 'register' ? 'is-active' : ''}
                onClick={() => setTab('register')}
              >
                注册
              </button>
            </div>
          ) : null}

          <h2 className="nm-login-title">{tab === 'register' ? '注册' : '登录'}</h2>
          <p className="nm-login-sub">
            {tab === 'register'
              ? '请填写邀请码完成注册，注册后自动登录。'
              : '请用用户名及密码进行登录。'}
          </p>

          {tab === 'register' ? registerForm : loginForm}

          <Typography.Paragraph className="nm-login-foot">
            {registrationOpen === false
              ? '当前未开放注册 —— 需要邀请码，请联系站点管理员。'
              : '忘记密码请联系站点管理员重置。'}
          </Typography.Paragraph>
        </div>
      </div>
    </div>
  );
}
