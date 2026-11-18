/** Member details used by variables. All values are plain data so rendering stays easy to test. */
export interface PersonVars {
  id: string;
  name: string;
  nickname: string;
  icon: string;
  discriminator: string;
}

export interface VariableContext {
  server?: { id: string; name: string; icon: string; banner: string };
  channel?: { id: string; name: string };
  panel?: { name: string; count: number; ticketLimit: number; padding: number };
  ticket?: {
    channelId: string;
    number: number;
    createdAt: number;
    claimedAt: number | null;
    closedAt: number | null;
    reopenedAt: number | null;
    deletedAt: number | null;
  };
  owner?: PersonVars;
  author?: PersonVars;
  claimUserId?: string | null;
  reason?: string | null;
  createReason?: string | null;
  closeReason?: string | null;
  deleteReason?: string | null;
  claimReason?: string | null;
  form?: string[];
  args?: string[];
  regex?: Record<string, string>;
  escalate?: { from: string; to: string; reason: string; userId: string };
  roleIdByName?: (name: string) => string | undefined;
  now?: number;
}

/** Stops text typed by members from pinging anyone once it is placed inside a message. */
export const neutralize = (value: string): string => value.replace(/@/g, '@​');

export function formatAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const parts: [number, string][] = [
    [Math.floor(seconds / 86_400), 'day'],
    [Math.floor((seconds % 86_400) / 3600), 'hour'],
    [Math.floor((seconds % 3600) / 60), 'minute'],
  ];
  const text = parts
    .filter(([amount]) => amount > 0)
    .slice(0, 2)
    .map(([amount, unit]) => `${amount} ${unit}${amount === 1 ? '' : 's'}`);
  if (text.length > 0) return text.join(', ');
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

const unix = (ms: number | null | undefined) => (ms ? String(Math.floor(ms / 1000)) : '');

function person(prefix: string, who: PersonVars | undefined, key: string): string | undefined {
  if (!who) return undefined;
  switch (key) {
    case prefix:
      return `<@${who.id}>`;
    case `${prefix}.id`:
      return who.id;
    case `${prefix}.name`:
      return neutralize(who.name);
    case `${prefix}.nickname`:
      return neutralize(who.nickname);
    case `${prefix}.icon`:
      return who.icon;
    case `${prefix}.tag`:
      return who.discriminator;
    case `${prefix}.full`:
      return neutralize(who.discriminator === '0' ? who.name : `${who.name}#${who.discriminator}`);
    default:
      return undefined;
  }
}

function resolve(rawKey: string, ctx: VariableContext): string | undefined {
  const key = rawKey.trim();
  const now = ctx.now ?? Date.now();
  const ticket = ctx.ticket;
  const member = (value: string | null | undefined) => neutralize(value ?? '');

  switch (key) {
    case 'server.name':
      return ctx.server && member(ctx.server.name);
    case 'server.id':
      return ctx.server?.id;
    case 'server.icon':
      return ctx.server?.icon;
    case 'server.banner':
      return ctx.server?.banner;
    case 'channel.name':
      return ctx.channel && member(ctx.channel.name);
    case 'channel.id':
      return ctx.channel?.id;
    case 'panel.count':
      return ctx.panel && String(ctx.panel.count);
    case 'panel.name':
      return ctx.panel && member(ctx.panel.name);
    case 'panel.ticketLimit':
      return ctx.panel && String(ctx.panel.ticketLimit);
    case 'count':
      if (!ctx.panel) return undefined;
      return String(ticket?.number ?? ctx.panel.count).padStart(ctx.panel.padding, '0');
    case 'ticket':
      return ticket && `<#${ticket.channelId}>`;
    case 'ticket.id':
      return ticket?.channelId;
    case 'empty':
      return '​';
    case 'reason':
      return member(ctx.reason ?? ctx.createReason ?? 'No reason provided');
    case 'create.reason':
      return member(ctx.createReason ?? 'No reason provided');
    case 'close.reason':
      return member(ctx.closeReason ?? 'No reason provided');
    case 'delete.reason':
      return member(ctx.deleteReason ?? 'No reason provided');
    case 'claim.reason':
      return member(ctx.claimReason ?? 'No reason provided');
    case 'claim.user':
      return ctx.claimUserId ? `<@${ctx.claimUserId}>` : 'Nobody';
    case 'escalate.from':
      return ctx.escalate && member(ctx.escalate.from);
    case 'escalate.to':
      return ctx.escalate && member(ctx.escalate.to);
    case 'escalate.reason':
      return ctx.escalate && member(ctx.escalate.reason);
    case 'escalate.user':
      return ctx.escalate && `<@${ctx.escalate.userId}>`;
    case 'time':
      return unix(now);
    case 'time.created':
      return ticket && unix(ticket.createdAt);
    case 'time.claimed':
      return ticket && unix(ticket.claimedAt);
    case 'time.closed':
      return ticket && unix(ticket.closedAt);
    case 'time.opened':
      return ticket && unix(ticket.reopenedAt);
    case 'time.deleted':
      return ticket && unix(ticket.deletedAt);
    case 'time.created.age':
      return ticket && formatAge(now - ticket.createdAt);
    case 'time.claimed.age':
      return ticket?.claimedAt ? formatAge(ticket.claimedAt - ticket.createdAt) : ticket && '';
    case 'time.closed.age':
      return ticket?.closedAt ? formatAge(ticket.closedAt - ticket.createdAt) : ticket && '';
    case 'time.opened.age':
      return ticket?.reopenedAt && ticket.closedAt ? formatAge(ticket.reopenedAt - ticket.closedAt) : ticket && '';
    case 'time.deleted.age':
      return ticket?.deletedAt ? formatAge(ticket.deletedAt - ticket.createdAt) : ticket && '';
    case 'user':
      return ctx.author && `<@${ctx.author.id}>`;
    default:
      break;
  }

  const ownerKey = key.replace(/^ticket\.owner/, 'ticket.user');
  const fromOwner = person('ticket.user', ctx.owner, ownerKey);
  if (fromOwner !== undefined) return fromOwner;
  const fromAuthor = person('author', ctx.author, key);
  if (fromAuthor !== undefined) return fromAuthor;

  const form = /^create\.form\.(\d+)$/.exec(key);
  if (form) return member(ctx.form?.[Number(form[1]) - 1] ?? '');

  const argument = /^argument\.(\d+)$/.exec(key);
  if (argument) return member(ctx.args?.[Number(argument[1]) - 1] ?? '');

  const regex = /^regex\.(.+)$/.exec(key);
  if (regex) return member(ctx.regex?.[regex[1]!] ?? '');

  const random = /^random(?:\.(-?\d+)\.(-?\d+))?$/.exec(key);
  if (random) {
    const low = random[1] === undefined ? 0 : Number(random[1]);
    const high = random[2] === undefined ? 100 : Number(random[2]);
    const [min, max] = low <= high ? [low, high] : [high, low];
    return String(Math.floor(Math.random() * (max - min + 1)) + min);
  }

  if (/^\d{17,20}$/.test(key)) return `<@&${key}>`;
  if (key.startsWith('@')) {
    const id = ctx.roleIdByName?.(key.slice(1));
    return id ? `<@&${id}>` : undefined;
  }
  return undefined;
}

/**
 * Replaces `{variables}` in a single pass, so a member who types `{ticket.user}` into a form answer
 * only ever produces that literal text. Unknown variables are left as written.
 */
export function renderVariables(template: string, ctx: VariableContext): string {
  return template.replace(/\{([^{}\n]{1,100})\}/g, (match, key: string) => resolve(key, ctx) ?? match);
}

/** Produces a valid Discord channel name from a rendered template. */
export function toChannelName(rendered: string, fallback = 'ticket'): string {
  const name = rendered
    .normalize('NFKC')
    .toLowerCase()
    .replace(/<[@#]&?(\d+)>/g, '$1')
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}\p{Emoji_Presentation}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return name || fallback;
}
