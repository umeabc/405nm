/**
 * 建首个站点管理员。放在 src/ 下是为了让 `tsc` 一并编译进 dist ——
 * 运行时镜像裁掉了 devDependencies，scripts/ 下的 tsx 脚本在容器里跑不起来。
 *
 * 本地：      ADMIN_USERNAME=admin ADMIN_PASSWORD=xxx npm run seed -w backend
 * 容器里：    docker compose -f deploy/docker-compose.yml run --rm \
 *               -e ADMIN_PASSWORD=xxx backend node backend/dist/seed.js
 *
 * 已存在同名用户时不覆盖密码，只提示 —— 避免误跑把线上密码刷掉。
 */
import { eq } from 'drizzle-orm';
import { hashPassword } from './auth/password.js';
import { closeDb, db } from './db/client.js';
import { users } from './db/schema.js';

const username = process.env.ADMIN_USERNAME ?? 'admin';
const password = process.env.ADMIN_PASSWORD ?? '';
const displayName = process.env.ADMIN_DISPLAY_NAME ?? '站点管理员';

if (password.length < 8) {
  console.error('请通过 ADMIN_PASSWORD 提供至少 8 位的管理员密码。');
  await closeDb();
  process.exit(1);
}

const existing = await db.select().from(users).where(eq(users.username, username)).limit(1);

if (existing.length > 0) {
  console.log(`用户 ${username} 已存在（id=${existing[0]?.id}），未做任何修改。`);
} else {
  const inserted = await db
    .insert(users)
    .values({
      username,
      displayName,
      passwordHash: await hashPassword(password),
      isSiteAdmin: true,
    })
    .returning({ id: users.id });

  console.log(`已创建站点管理员 ${username}（id=${inserted[0]?.id}）。请登录后立即修改密码。`);
}

await closeDb();
