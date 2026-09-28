import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db, type DbLike } from '../db/client.js';
import { inviteCodes, roles, teamMembers, teams, type InviteCode } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { normalizeInviteCode } from '../lib/validate.js';

/**
 * 邀请码制注册。
 *
 * 两条通道，与图译空间一致：
 *  1. `.env` 里的 `INVITE_CODE` —— 应急/本地便捷通道，可重复使用、不入团；
 *  2. `invite_codes` 表 —— 正式通道，**一码绑一团队**，注册后自动入团并授予指定角色。
 *
 * 与 moeflow 的差异：moeflow 的邀请码只决定「能不能注册」，队伍归属靠事后再加；
 * 这里把入团做成注册的一部分，省掉新人进来后「不知道该找谁加团」的一步。
 */

export type InviteValidation = {
  ok: true;
  /** 表内邀请码；env 通道为 null */
  invite: InviteCode | null;
  viaEnv: boolean;
};

export function envInviteCode(): string | null {
  const code = process.env.INVITE_CODE?.trim();
  return code ? normalizeInviteCode(code) : null;
}

export async function validateInviteCode(rawCode: string): Promise<InviteValidation> {
  const code = normalizeInviteCode(rawCode);
  if (!code) throw badRequest('请输入邀请码', 'INVITE_REQUIRED');

  // env 通道优先：它是运维兜底，即使表里没有也能进。
  const envCode = envInviteCode();
  if (envCode && code === envCode) {
    return { ok: true, invite: null, viaEnv: true };
  }

  const rows = await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.code, code))
    .limit(1);

  const invite = rows[0];
  if (!invite) throw badRequest('邀请码无效', 'INVITE_INVALID');
  if (!invite.enabled) throw badRequest('该邀请码已停用', 'INVITE_DISABLED');
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
    throw badRequest('该邀请码已过期', 'INVITE_EXPIRED');
  }
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
    throw badRequest('该邀请码已达到使用次数上限', 'INVITE_EXHAUSTED');
  }

  return { ok: true, invite, viaEnv: false };
}

/**
 * 在**注册事务内**消费邀请码并把新人拉进团队。
 *
 * 用带条件的 UPDATE 做原子扣减：`used_count < max_uses` 写在 WHERE 里，
 * 两个人同时用最后一个名额时只有一个能成功 —— 而不是先查后写导致超发。
 */
export async function consumeInviteCode(
  tx: DbLike,
  inviteId: string,
): Promise<void> {
  const updated = await tx
    .update(inviteCodes)
    .set({ usedCount: sql`${inviteCodes.usedCount} + 1` })
    .where(
      and(
        eq(inviteCodes.id, inviteId),
        eq(inviteCodes.enabled, true),
        or(isNull(inviteCodes.maxUses), sql`${inviteCodes.usedCount} < ${inviteCodes.maxUses}`),
      ),
    )
    .returning({ id: inviteCodes.id });

  if (updated.length !== 1) {
    throw badRequest('邀请码已被用完或已停用', 'INVITE_EXHAUSTED');
  }
}

/**
 * 把新用户按邀请码的设定拉进团队。
 * 角色优先用邀请码上指定的；没指定就落到团队的默认角色。
 */
export async function joinTeamByInvite(
  tx: DbLike,
  invite: InviteCode,
  userId: string,
): Promise<string | null> {
  if (!invite.teamId) return null;

  const teamRows = await tx
    .select({ id: teams.id, defaultRoleId: teams.defaultRoleId })
    .from(teams)
    .where(eq(teams.id, invite.teamId))
    .limit(1);

  const team = teamRows[0];
  if (!team) throw notFound('邀请码指向的团队不存在', 'TEAM_NOT_FOUND');

  const roleId = invite.roleId ?? team.defaultRoleId;
  if (!roleId) throw badRequest('该团队尚未配置默认角色，请联系团队管理员', 'TEAM_NO_DEFAULT_ROLE');

  await tx
    .insert(teamMembers)
    .values({ teamId: team.id, userId, roleId })
    .onConflictDoNothing();

  return team.id;
}

/** 校验邀请码上绑定的角色确实属于该团队 —— 防止跨团授权。 */
export async function assertInviteRoleBelongsToTeam(
  teamId: string,
  roleId: string | null | undefined,
): Promise<void> {
  if (!roleId) return;
  const rows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.teamId, teamId)))
    .limit(1);
  if (rows.length === 0) throw badRequest('所选角色不属于该团队', 'ROLE_TEAM_MISMATCH');
}
