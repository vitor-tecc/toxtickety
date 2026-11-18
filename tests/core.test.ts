import { describe, expect, it } from 'vitest';
import { parseGuild, parsePanel, scheduleSchema, customCommandSchema, automationSchema } from '../src/config/schema.js';
import { buildOverwrites, evaluateButton, evaluateCommand } from '../src/core/access.js';
import { onMatchingMessage, onWindowEnd } from '../src/core/automationRules.js';
import { matchCustomCommand } from '../src/core/customCommands.js';
import { renderMessage } from '../src/core/render.js';
import { isWithinSchedule } from '../src/core/schedule.js';
import { RenameGuard, parseEmoji } from '../src/core/tickets.js';
import { escapeHtml, renderMarkdown, renderTranscript } from '../src/core/transcript.js';
import { renderVariables, toChannelName, type VariableContext } from '../src/core/variables.js';
import { parseArgs } from '../src/discord/args.js';
import { shouldRejectRateLimit } from '../src/discord/bot.js';
import { slashDefinitions } from '../src/discord/commands.js';

const person = { id: '111111111111111111', name: 'alice', nickname: 'Alice', icon: 'https://x/a.png', discriminator: '0' };
const ctx: VariableContext = {
  panel: { name: 'Complaints', count: 41, ticketLimit: 1, padding: 4 },
  ticket: { channelId: '222222222222222222', number: 42, createdAt: 0, claimedAt: null, closedAt: 3_600_000, reopenedAt: null, deletedAt: null },
  owner: person,
  author: person,
  now: 7_200_000,
};

describe('variables', () => {
  it('names a ticket complaint-0042', () => {
    expect(toChannelName(renderVariables('complaint-{count}', ctx))).toBe('complaint-0042');
  });
  it('resolves owner, author and time variables', () => {
    expect(renderVariables('{ticket.user} {ticket.owner.name} {author.id}', ctx)).toBe(`<@${person.id}> alice ${person.id}`);
    expect(renderVariables('{time.closed.age}', ctx)).toBe('1 hour');
  });
  it('leaves unknown variables alone', () => {
    expect(renderVariables('{nope}', ctx)).toBe('{nope}');
  });
  it('does not expand variables typed by members', () => {
    const out = renderVariables('{create.form.1}', { ...ctx, form: ['{ticket.user} @everyone <@&1>'] });
    expect(out).toBe('{ticket.user} @​everyone <@​&1>');
  });
  it('makes valid channel names', () => {
    expect(toChannelName('My  Big_Ticket!! #7')).toBe('my-big-ticket-7');
    expect(toChannelName('!!!')).toBe('ticket');
    expect(toChannelName('a'.repeat(200))).toHaveLength(100);
  });
});

describe('message rendering', () => {
  const base = parsePanel().ticket.message;
  it('renders the default ticket message', () => {
    const out = renderMessage(base, ctx);
    expect(out.content).toBe(`<@${person.id}> Welcome`);
    expect(out.embeds).toHaveLength(1);
    expect(out.allowedMentions.parse).not.toContain('everyone');
  });
  it('only lets admin text ping everyone', () => {
    const template = { content: '{create.form.1}', embeds: [] };
    expect(renderMessage(template, { ...ctx, form: ['@everyone'] }).allowedMentions.parse).not.toContain('everyone');
    expect(renderMessage({ content: '@everyone hi', embeds: [] }, ctx).allowedMentions.parse).toContain('everyone');
  });
  it('keeps embeds within the 6000 character limit', () => {
    const embed = parsePanel().ticket.message.embeds[0]!;
    const big = { ...embed, description: 'x'.repeat(4096) };
    const out = renderMessage({ content: '', embeds: [big, big, big] }, ctx);
    expect(out.embeds.reduce((sum, item) => sum + (item.description?.length ?? 0), 0)).toBeLessThanOrEqual(6000);
  });
  it('drops links that are not http', () => {
    const embed = { ...parsePanel().ticket.message.embeds[0]!, title: 'Hi', url: 'javascript:alert(1)', image: 'nope' };
    const out = renderMessage({ content: '', embeds: [embed] }, ctx);
    expect(out.embeds[0]!.url).toBeUndefined();
    expect(out.embeds[0]!.image).toBeUndefined();
  });
});

describe('access rules', () => {
  const rule = parseGuild().commands.close;
  const member = { roles: ['1'], isAdmin: false, isSupport: false };
  it('applies support-only and role lists', () => {
    expect(evaluateCommand({ ...rule, supportOnly: true }, member, ['c']).allowed).toBe(false);
    expect(evaluateCommand({ ...rule, supportOnly: true, allowedRoles: ['1'] }, member, ['c']).allowed).toBe(true);
    expect(evaluateCommand({ ...rule, disabledRoles: ['1'] }, member, ['c']).allowed).toBe(false);
    expect(evaluateCommand({ ...rule, disabledRoles: ['1'], allowedRoles: ['1'] }, member, ['c']).allowed).toBe(true);
  });
  it('applies channel lists, even to admins', () => {
    const admin = { ...member, isAdmin: true };
    expect(evaluateCommand({ ...rule, allowedChannels: ['x'] }, admin, ['c']).allowed).toBe(false);
    expect(evaluateCommand({ ...rule, allowedChannels: ['c'], disabledChannels: ['c'] }, member, ['c']).allowed).toBe(true);
    expect(evaluateCommand({ ...rule, enabled: false }, admin, ['c']).allowed).toBe(false);
  });
  it('checks buttons', () => {
    const button = parsePanel().buttons.delete;
    expect(evaluateButton(button, member).allowed).toBe(false);
    expect(evaluateButton(button, { ...member, isSupport: true }).allowed).toBe(true);
  });
});

describe('ticket permissions', () => {
  const S = '300000000000000001';
  const A = '300000000000000002';
  const input = {
    guildId: 'g',
    botId: 'bot',
    config: parsePanel({ general: { supportRoles: [S], additionalRoles: [A] } }),
    state: 'open' as const,
    ownerId: 'o',
    ownerIsSupport: false,
    addedUsers: ['u'],
    addedRoles: [],
    claimedBy: null,
  };
  const find = (list: ReturnType<typeof buildOverwrites>, id: string) => list.find((item) => item.id === id)!;
  it('hides open tickets from everyone else', () => {
    const list = buildOverwrites(input);
    expect(find(list, 'g').deny).toContain('ViewChannel');
    expect(find(list, 'o').allow).toContain('SendMessages');
    expect(find(list, 'u').allow).toContain('ViewChannel');
    expect(find(list, A).deny).toContain('SendMessages');
    expect(find(list, 'bot').allow).toContain('ViewChannel');
  });
  it('removes the owner when closed', () => {
    const list = buildOverwrites({ ...input, state: 'closed' });
    expect(find(list, 'o').deny).toContain('ViewChannel');
    expect(find(list, S).allow).toContain('ViewChannel');
  });
  it('limits other staff on claimed tickets when configured', () => {
    const config = parsePanel({ general: { supportRoles: [S] }, claiming: { enabled: true, changeSupportPermissions: true } });
    const list = buildOverwrites({ ...input, config, claimedBy: 'c' });
    expect(find(list, S).deny).toContain('SendMessages');
    expect(find(list, 'c').allow).toContain('SendMessages');
  });
});

describe('schedule', () => {
  const schedule = scheduleSchema.parse({
    enabled: true,
    timezone: 'America/Sao_Paulo',
    monday: [{ start: '09:00', end: '17:00' }],
    friday: [{ start: '22:00', end: '02:00' }],
  });
  it('uses the configured timezone', () => {
    expect(isWithinSchedule(schedule, new Date('2026-11-16T12:00:00Z'))).toBe(true); // 09:00 Monday
    expect(isWithinSchedule(schedule, new Date('2026-11-16T11:59:00Z'))).toBe(false);
    expect(isWithinSchedule(schedule, new Date('2026-11-16T20:00:00Z'))).toBe(false); // 17:00 ends
  });
  it('handles windows that cross midnight', () => {
    expect(isWithinSchedule(schedule, new Date('2026-11-21T02:00:00Z'))).toBe(true); // 23:00 Friday
    expect(isWithinSchedule(schedule, new Date('2026-11-21T04:30:00Z'))).toBe(true); // 01:30 Saturday
    expect(isWithinSchedule(schedule, new Date('2026-11-21T05:30:00Z'))).toBe(false);
  });
  it('is always open when disabled', () => {
    expect(isWithinSchedule({ ...schedule, enabled: false }, new Date())).toBe(true);
  });
});

describe('custom commands', () => {
  const command = (value: object) => customCommandSchema.parse(value);
  it('matches strict triggers', () => {
    expect(matchCustomCommand(command({ trigger: '!Hi' }), '!hi')).not.toBeNull();
    expect(matchCustomCommand(command({ trigger: '!Hi', caseSensitive: true }), '!hi')).toBeNull();
    expect(matchCustomCommand(command({ trigger: '!hi' }), '!hi there')).toBeNull();
  });
  it('matches wildcards', () => {
    const fish = command({ triggerType: 'wildcard', trigger: 'f*ish' });
    expect(matchCustomCommand(fish, 'fancy dish')).not.toBeNull();
    expect(matchCustomCommand(fish, 'fish tank')).toBeNull();
  });
  it('captures regex groups', () => {
    const match = matchCustomCommand(command({ triggerType: 'regex', trigger: 'order (?<id>\\d+)' }), 'my order 55');
    expect(match?.regex.id).toBe('55');
  });
  it('splits arguments', () => {
    const say = command({ trigger: '!say', argumentCount: 2 });
    expect(matchCustomCommand(say, '!say one, two, three')?.args).toEqual(['one', 'two, three']);
  });
  it('survives a catastrophic pattern', () => {
    const slow = command({ triggerType: 'regex', trigger: '(a+)+$' });
    const started = Date.now();
    expect(matchCustomCommand(slow, `${'a'.repeat(40)}!`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('rejects invalid patterns when saving', () => {
    expect(customCommandSchema.safeParse({ triggerType: 'regex', trigger: '(' }).success).toBe(false);
  });
});

describe('automation decisions', () => {
  const rule = (value: object) => automationSchema.parse({ windowSeconds: 600, ...value });
  const job = { runAt: 1000, seen: false };
  it('fires a not-found check when the window ends quietly', () => {
    expect(onWindowEnd(rule({ checkType: 'notFound' }), job, 1000)).toEqual({ runAction: true, next: null });
  });
  it('restarts the timer when a message arrives', () => {
    const out = onMatchingMessage(rule({ checkType: 'notFound', onMessageInWindow: 'restart' }), job, 500);
    expect(out).toEqual({ runAction: false, next: { runAt: 600_500, seen: false } });
  });
  it('remembers the message when the timer keeps running', () => {
    const noted = onMatchingMessage(rule({ checkType: 'notFound', onMessageInWindow: 'continue' }), job, 500);
    expect(noted).toEqual({ runAction: false, next: { runAt: 1000, seen: true } });
    expect(onWindowEnd(rule({ checkType: 'notFound', onMessageInWindow: 'continue' }), noted.next!, 1000).runAction).toBe(false);
  });
  it('fires a found check on the message', () => {
    expect(onMatchingMessage(rule({ checkType: 'found' }), job, 500).runAction).toBe(true);
  });
  it('repeats until stopped when asked', () => {
    const repeating = rule({ checkType: 'notFound', repeat: 'untilStopped', afterAction: 'keepChecking' });
    expect(onWindowEnd(repeating, job, 1000)).toEqual({ runAction: true, next: { runAt: 601_000, seen: false } });
  });
  it('enforces the 5 minute minimum', () => {
    expect(automationSchema.safeParse({ windowSeconds: 60 }).success).toBe(false);
  });
});

describe('transcripts', () => {
  const meta = {
    serverName: '<b>Server</b>',
    channelName: 'ticket-1',
    panelName: 'Panel',
    ownerName: '<img src=x onerror=alert(1)>',
    ownerId: '1',
    generatedAt: 0,
    resolveUser: () => '<script>x</script>',
    resolveRole: () => undefined,
    resolveChannel: () => undefined,
  };
  const message = {
    id: '1', authorName: '"><script>alert(1)</script>', authorId: '1', authorAvatar: 'javascript:alert(1)', authorIsBot: false,
    createdAt: 0, editedAt: null, content: '<script>alert(1)</script> **bold** <@111111111111111111> [x](javascript:alert(1))',
    attachments: [{ name: '<img onerror=1>.png', url: 'javascript:alert(1)', size: 1, contentType: 'image/png' }],
    embeds: [{ title: '<i>', description: '<svg onload=alert(1)>', url: 'javascript:alert(1)', color: 255, author: '<u>', footer: '<u>', image: 'javascript:1', fields: [{ name: '<a>', value: '<b>' }] }],
    stickers: ['<s>'],
  };
  it('never lets message content become markup', () => {
    const html = renderTranscript([message], meta);
    const body = html.slice(html.indexOf('<body>'));
    expect(body).not.toMatch(/<script|<svg|<img src=x|href="javascript|src="javascript/i);
    expect(body).toContain('<strong>bold</strong>');
    expect(html).toContain("default-src 'none'");
  });
  it('escapes the important characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
  it('keeps code blocks literal', () => {
    expect(renderMarkdown('`**x**`', meta)).toBe('<code>**x**</code>');
  });
});

describe('prefix arguments', () => {
  const options = [
    { name: 'user', description: '', type: 'user' as const },
    { name: 'panel', description: '', type: 'integer' as const },
    { name: 'reason', description: '', type: 'string' as const },
  ];
  it('skips optional arguments that do not fit', () => {
    const out = parseArgs(options, 'I need help');
    expect(out).toEqual({ ok: true, args: { reason: { kind: 'text', value: 'I need help' } } });
  });
  it('reads mentions and keeps the remaining text', () => {
    const out = parseArgs(options, '<@123456789012345678> 2 broken thing');
    expect(out.ok && out.args.user).toEqual({ kind: 'user', id: '123456789012345678' });
    expect(out.ok && out.args.panel).toEqual({ kind: 'number', value: 2 });
    expect(out.ok && out.args.reason).toEqual({ kind: 'text', value: 'broken thing' });
  });
  it('reports a missing required argument', () => {
    expect(parseArgs([{ name: 'name', description: '', type: 'string', required: true }], '')).toEqual({ ok: false, missing: 'name' });
  });
});

describe('rate limits', () => {
  const limit = { method: 'PATCH', route: '/channels/123456789012345678', timeToReset: 0, retryAfter: 0, sublimitTimeout: 0 } as never as Parameters<typeof shouldRejectRateLimit>[0];
  it('fails fast on long channel rename limits', () => {
    expect(shouldRejectRateLimit({ ...limit, sublimitTimeout: 600_000 })).toBe(true);
    expect(shouldRejectRateLimit({ ...limit, timeToReset: 600_000 })).toBe(true);
  });
  it('waits out short limits and leaves other routes alone', () => {
    expect(shouldRejectRateLimit({ ...limit, timeToReset: 1000 })).toBe(false);
    expect(shouldRejectRateLimit({ ...limit, route: '/channels/123456789012345678/messages/:id', timeToReset: 600_000 })).toBe(false);
  });
});

describe('misc', () => {
  it('allows only two renames per ten minutes', () => {
    const guard = new RenameGuard();
    expect(guard.allow('c', 0)).toBe(true);
    expect(guard.allow('c', 1)).toBe(true);
    expect(guard.allow('c', 2)).toBe(false);
    expect(guard.allow('c', 600_001)).toBe(true);
  });
  it('parses emoji', () => {
    expect(parseEmoji('🔒')).toEqual({ name: '🔒' });
    expect(parseEmoji('<a:wave:123456789012345678>')).toEqual({ id: '123456789012345678', name: 'wave', animated: true });
    expect(parseEmoji('nope')).toBeNull();
  });
  it('builds valid slash commands', () => {
    const definitions = slashDefinitions();
    expect(definitions.length).toBeGreaterThanOrEqual(20);
    for (const command of definitions) expect(command.description.length).toBeLessThanOrEqual(100);
  });
  it('gives every setting a default', () => {
    const panel = parsePanel();
    expect(panel.ticket.openedName).toBe('ticket-{count}');
    expect(panel.general.padding).toBe(4);
    expect(panel.buttons.close.label).toBe('Close');
    expect(panel.permissions.closed.user.deny).toContain('ViewChannel');
    expect(parseGuild().general.prefix).toBe('$');
  });
});
