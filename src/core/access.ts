import type { ButtonConfig, ChannelPermission, CommandRule, PanelConfig, PermissionSet } from '../config/schema.js';

export interface Actor {
  roles: string[];
  isAdmin: boolean;
  isSupport: boolean;
}

const overlaps = (a: readonly string[], b: readonly string[]) => a.some((item) => b.includes(item));

export type Verdict = { allowed: true } | { allowed: false; reason: string };
const allow: Verdict = { allowed: true };
const deny = (reason: string): Verdict => ({ allowed: false, reason });

/** Command Configs: channel lists first, then roles. Allow lists override deny lists. */
export function evaluateCommand(rule: CommandRule, actor: Actor, channelIds: string[]): Verdict {
  if (!rule.enabled) return deny('This command is disabled on this server.');
  if (rule.allowedChannels.length > 0) {
    if (!overlaps(rule.allowedChannels, channelIds)) return deny('This command cannot be used in this channel.');
  } else if (overlaps(rule.disabledChannels, channelIds)) {
    return deny('This command cannot be used in this channel.');
  }
  if (actor.isAdmin) return allow;
  return evaluateRoles(rule, actor, 'You do not have permission to use this command.');
}

/** Button Options use the same role logic as commands. */
export function evaluateButton(button: ButtonConfig, actor: Actor): Verdict {
  if (actor.isAdmin) return allow;
  return evaluateRoles(button, actor, 'You do not have permission to use this button.');
}

function evaluateRoles(
  rule: { supportOnly: boolean; allowedRoles: string[]; disabledRoles: string[] },
  actor: Actor,
  message: string,
): Verdict {
  if (overlaps(rule.allowedRoles, actor.roles)) return allow;
  if (overlaps(rule.disabledRoles, actor.roles)) return deny(message);
  if (rule.allowedRoles.length > 0 && !actor.isSupport) return deny(message);
  if (rule.supportOnly && !actor.isSupport) return deny(message);
  return allow;
}

export interface Overwrite {
  id: string;
  type: 'role' | 'member';
  allow: ChannelPermission[];
  deny: ChannelPermission[];
}

export interface OverwriteInput {
  guildId: string;
  botId: string;
  config: PanelConfig;
  state: 'open' | 'closed';
  ownerId: string;
  ownerIsSupport: boolean;
  addedUsers: string[];
  addedRoles: string[];
  claimedBy: string | null;
}

const BOT_PERMISSIONS: ChannelPermission[] = [
  'ViewChannel',
  'SendMessages',
  'ReadMessageHistory',
  'EmbedLinks',
  'AttachFiles',
  'ManageMessages',
  'CreatePrivateThreads',
  'SendMessagesInThreads',
  'ManageThreads',
];

/**
 * Builds a ticket channel's complete permission list from its current state. Always rebuilding the
 * whole list means opening, closing, claiming and escalating can never leave stale access behind.
 */
export function buildOverwrites(input: OverwriteInput): Overwrite[] {
  const { config, state, claimedBy } = input;
  const perms = config.permissions[state === 'open' ? 'opened' : 'closed'];
  const claimLimited = state === 'open' && claimedBy !== null && config.claiming.enabled && config.claiming.changeSupportPermissions;
  const supportPerms: PermissionSet = claimLimited ? config.claiming.claimedSupportPermissions : perms.support;

  const list = new Map<string, Overwrite>();
  const put = (id: string, type: Overwrite['type'], set: PermissionSet) =>
    list.set(id, { id, type, allow: [...set.allow], deny: [...set.deny] });

  put(input.guildId, 'role', perms.everyone);
  for (const role of config.general.additionalRoles) put(role, 'role', perms.additional);
  for (const role of input.addedRoles) put(role, 'role', perms.user);
  for (const role of config.general.supportRoles) put(role, 'role', supportPerms);
  for (const user of input.addedUsers) put(user, 'member', perms.user);
  put(input.ownerId, 'member', input.ownerIsSupport ? perms.support : perms.user);
  if (claimLimited && claimedBy) put(claimedBy, 'member', perms.support);
  put(input.botId, 'member', { allow: BOT_PERMISSIONS, deny: [] });
  return [...list.values()];
}
