import { ChannelType } from 'discord.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseGuild, parsePanel } from '../src/config/schema.js';
import { TicketService } from '../src/core/tickets.js';
import { Store } from '../src/db/store.js';
import { addRole, fakeChannel, fakeClient, fakeGuild, fakeMember, snowflake } from './helpers/fakes.js';

function setup(panelConfig: object = {}) {
  const store = new Store(':memory:');
  const guild = fakeGuild();
  const client = fakeClient(guild);
  const service = new TicketService(client, store, 0);
  const supportRole = addRole(guild, 'Support');
  const owner = fakeMember(guild, snowflake(), 'alice') as any;
  const staff = fakeMember(guild, snowflake(), 'bob', { roles: [supportRole] }) as any;
  const other = fakeMember(guild, snowflake(), 'carol', { roles: [supportRole] }) as any;
  const category = fakeChannel(guild, 'tickets', ChannelType.GuildCategory);
  const closedCategory = fakeChannel(guild, 'closed', ChannelType.GuildCategory);
  const logs = fakeChannel(guild, 'logs', ChannelType.GuildText);
  const transcripts = fakeChannel(guild, 'transcripts', ChannelType.GuildText);
  const panel = store.createPanel(
    guild.id,
    'Complaints',
    parsePanel({
      general: { supportRoles: [supportRole] },
      category: { opened: category.id, closed: closedCategory.id },
      ticket: { openedName: 'complaint-{count}', closedName: 'closed-{count}' },
      logging: { channel: logs.id },
      transcript: { channel: transcripts.id },
      ...panelConfig,
    }),
  );
  const channelOf = (ticket: { channelId: string | null }) => guild.channelMap.get(ticket.channelId!);
  return { store, guild, service, owner, staff, other, panel, category, closedCategory, logs, transcripts, supportRole, channelOf };
}

describe('ticket lifecycle', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('opens a private ticket with the configured name', async () => {
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    const channel = t.channelOf(ticket);
    expect(channel.name).toBe('complaint-0001');
    expect(channel.parentId).toBe(t.category.id);
    expect(ticket.state).toBe('open');
    const everyone = channel.overwrites.find((item: any) => item.id === t.guild.id);
    expect(everyone.deny.length).toBeGreaterThan(0);
    expect(channel.sent[0].components).toHaveLength(1);
    expect(t.logs.sent).toHaveLength(1);
  });

  it('numbers tickets in order', async () => {
    await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    const second = await t.service.open({ panel: t.panel, owner: t.staff, actor: t.staff });
    expect(t.channelOf(second).name).toBe('complaint-0002');
  });

  it('enforces the per-member limit, including under simultaneous clicks', async () => {
    const results = await Promise.allSettled([
      t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner }),
      t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner }),
      t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('releases the slot when channel creation fails', async () => {
    const original = t.guild.channels.create;
    t.guild.channels.create = async () => {
      throw Object.assign(new Error('nope'), { code: 50013 });
    };
    await expect(t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner })).rejects.toThrow(/missing permissions/i);
    t.guild.channels.create = original;
    await expect(t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner })).resolves.toBeTruthy();
  });

  it('closes, reopens and deletes', async () => {
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    const channel = t.channelOf(ticket);

    await t.service.close(ticket, t.staff, 'Solved');
    let current = t.store.getTicket(ticket.id)!;
    expect(current.state).toBe('closed');
    expect(current.closeReason).toBe('Solved');
    expect(channel.name).toBe('closed-0001');
    expect(channel.parentId).toBe(t.closedCategory.id);
    expect(current.modMessageId).toBeTruthy();
    const ownerAccess = channel.overwrites.find((item: any) => item.id === t.owner.id);
    expect(ownerAccess.deny.length).toBeGreaterThan(0);
    await expect(t.service.close(current, t.staff)).rejects.toThrow(/already closed/i);

    await t.service.reopen(current, t.staff);
    current = t.store.getTicket(ticket.id)!;
    expect(current.state).toBe('open');
    expect(channel.name).toBe('complaint-0001');
    expect(channel.parentId).toBe(t.category.id);
    expect(current.modMessageId).toBeNull();

    await t.service.delete(current, t.staff, 'Done');
    expect(t.store.getTicket(ticket.id)!.state).toBe('deleted');
    expect(channel.deleted).toBe(true);
  });

  it('rolls back when the channel cannot be locked', async () => {
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    t.channelOf(ticket).edit = async () => {
      throw Object.assign(new Error('nope'), { code: 50013 });
    };
    await expect(t.service.close(ticket, t.staff)).rejects.toThrow(/missing permissions/i);
    expect(t.store.getTicket(ticket.id)!.state).toBe('open');
  });

  it('skips the third rename within ten minutes instead of hanging', async () => {
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    await t.service.rename(ticket, t.staff, 'first');
    await t.service.rename(ticket, t.staff, 'second');
    await expect(t.service.rename(ticket, t.staff, 'third')).rejects.toThrow(/2 renames/);
  });

  it('adds and removes members', async () => {
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    const guest = fakeMember(t.guild, snowflake(), 'dave') as any;
    await t.service.addAccess(ticket, t.staff, guest);
    let current = t.store.getTicket(ticket.id)!;
    expect(current.addedUsers).toEqual([guest.id]);
    expect(t.channelOf(ticket).overwrites.some((item: any) => item.id === guest.id)).toBe(true);
    await expect(t.service.removeAccess(current, t.staff, t.owner)).rejects.toThrow(/owner/i);
    await t.service.removeAccess(current, t.staff, guest);
    current = t.store.getTicket(ticket.id)!;
    expect(current.addedUsers).toEqual([]);
    expect(t.channelOf(ticket).overwrites.some((item: any) => item.id === guest.id)).toBe(false);
  });

  it('marks tickets gone when the channel is deleted by hand', async () => {
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    t.service.markChannelGone(ticket.channelId!);
    expect(t.store.getTicket(ticket.id)!.state).toBe('deleted');
  });
});

describe('claiming', () => {
  it('claims, blocks others and unclaims', async () => {
    const t = setup({ claiming: { enabled: true, nameEnabled: true, name: 'claimed-{count}', restrictActions: true, onlyClaimerCanUnclaim: true } });
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    expect(t.channelOf(ticket).sent[0].components[0].components).toHaveLength(2);

    await t.service.claim(ticket, t.staff, t.staff);
    let current = t.store.getTicket(ticket.id)!;
    expect(current.claimedBy).toBe(t.staff.id);
    expect(t.channelOf(ticket).name).toBe('claimed-0001');

    await expect(t.service.claim(current, t.other, t.other)).rejects.toThrow(/already claimed/i);
    await expect(t.service.unclaim(current, t.other)).rejects.toThrow(/only the member/i);
    await t.service.close(current, t.staff);
    await expect(t.service.reopen(t.store.getTicket(ticket.id)!, t.other)).rejects.toThrow(/only the member/i);
    await t.service.reopen(t.store.getTicket(ticket.id)!, t.staff);

    current = t.store.getTicket(ticket.id)!;
    await t.service.unclaim(current, t.staff);
    expect(t.store.getTicket(ticket.id)!.claimedBy).toBeNull();
  });

  it('refuses members outside the team', async () => {
    const t = setup({ claiming: { enabled: true } });
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    await expect(t.service.claim(ticket, t.owner, t.owner)).rejects.toThrow(/owners cannot/i);
  });

  it('takes over a claim when configured', async () => {
    const t = setup({ claiming: { enabled: true, overwriteClaim: true } });
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    await t.service.pressClaim(ticket, t.staff);
    await t.service.pressClaim(t.store.getTicket(ticket.id)!, t.other);
    expect(t.store.getTicket(ticket.id)!.claimedBy).toBe(t.other.id);
    await t.service.pressClaim(t.store.getTicket(ticket.id)!, t.other);
    expect(t.store.getTicket(ticket.id)!.claimedBy).toBeNull();
  });
});

describe('escalation', () => {
  it('moves a ticket to another panel', async () => {
    const t = setup({ claiming: { enabled: true } });
    const target = t.store.createPanel(t.guild.id, 'Legal', parsePanel({ ticket: { openedName: 'legal-{count}' }, general: { supportRoles: [t.supportRole] } }));
    t.store.updatePanel(t.panel.id, t.panel.name, { ...t.panel.config, escalate: { ...t.panel.config.escalate, panels: [target.id] } });
    const panel = t.store.getPanel(t.panel.id)!;
    const ticket = await t.service.open({ panel, owner: t.owner, actor: t.owner });
    await t.service.claim(ticket, t.staff, t.staff);
    t.service.rememberEscalationReason(ticket, 'Needs legal');
    await t.service.escalate(t.store.getTicket(ticket.id)!, t.staff, target);
    const moved = t.store.getTicket(ticket.id)!;
    expect(moved.panelId).toBe(target.id);
    expect(moved.claimedBy).toBeNull();
    const channel = t.channelOf(ticket);
    expect(channel.name).toBe('legal-0001');
    expect(channel.sent.at(-1).embeds[0].description).toContain('Needs legal');
  });

  it('refuses panels that are not allowed', async () => {
    const t = setup();
    const target = t.store.createPanel(t.guild.id, 'Legal');
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    await expect(t.service.escalate(ticket, t.staff, target)).rejects.toThrow(/not set up/i);
  });
});

describe('panel options', () => {
  it('deletes right away when closed tickets are not kept', async () => {
    const t = setup({ general: { twoStepTicket: false } });
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    await t.service.close(ticket, t.staff);
    expect(t.store.getTicket(ticket.id)!.state).toBe('deleted');
  });

  it('uses overflow categories when the first is full', async () => {
    const t = setup();
    const overflow = fakeChannel(t.guild, 'overflow', ChannelType.GuildCategory);
    for (let index = 0; index < 50; index += 1) fakeChannel(t.guild, `x${index}`, ChannelType.GuildText, t.category.id);
    t.store.updatePanel(t.panel.id, t.panel.name, { ...t.panel.config, category: { ...t.panel.config.category, overflow: [overflow.id] } });
    const ticket = await t.service.open({ panel: t.store.getPanel(t.panel.id)!, owner: t.owner, actor: t.owner });
    expect(t.channelOf(ticket).parentId).toBe(overflow.id);
  });

  it('explains when every category is full', async () => {
    const t = setup();
    for (let index = 0; index < 50; index += 1) fakeChannel(t.guild, `x${index}`, ChannelType.GuildText, t.category.id);
    await expect(t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner })).rejects.toThrow(/full/i);
    expect(t.store.listLiveTickets()).toHaveLength(0);
  });

  it('turns members away outside opening hours', async () => {
    const t = setup({ limits: { schedule: { enabled: true, message: { content: 'We are closed', embeds: [] } } } });
    await expect(t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner })).rejects.toThrow('We are closed');
  });

  it('can open anyway with the schedule message', async () => {
    const t = setup({ limits: { schedule: { enabled: true, replaceTicketMessage: true, message: { content: 'Back soon', embeds: [] } } } });
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    expect(t.channelOf(ticket).sent[0].content).toBe('Back soon');
  });

  it('shows form answers without pinging anyone', async () => {
    const t = setup({ form: { enabled: true, questions: [{ title: 'What happened?' }] } });
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner, form: ['@everyone it broke'] });
    const answers = t.channelOf(ticket).sent[1];
    expect(answers.allowedMentions.parse).toEqual([]);
  });

  it('creates thread tickets', async () => {
    const t = setup();
    const parent = fakeChannel(t.guild, 'support', ChannelType.GuildText);
    t.store.updatePanel(t.panel.id, t.panel.name, { ...t.panel.config, threadStyle: { ...t.panel.config.threadStyle, enabled: true, parentChannel: parent.id } });
    const panel = t.store.getPanel(t.panel.id)!;
    const originalCreate = parent.threads.create;
    parent.threads.create = async (options: any) => {
      const thread = await originalCreate(options);
      t.guild.channelMap.set(thread.id, thread);
      return thread;
    };
    const ticket = await t.service.open({ panel, owner: t.owner, actor: t.owner });
    expect(ticket.isThread).toBe(true);
    await t.service.close(ticket, t.staff);
    expect(t.channelOf(ticket).locked).toBe(true);
    await t.service.reopen(t.store.getTicket(ticket.id)!, t.staff);
    expect(t.channelOf(ticket).locked).toBe(false);
  });

  it('saves transcripts automatically and DMs the owner', async () => {
    const t = setup({ transcript: { autoSave: 'close', dmOwner: 'close' } });
    t.store.updatePanel(t.panel.id, t.panel.name, { ...t.panel.config, transcript: { ...t.panel.config.transcript, channel: t.transcripts.id, autoSave: 'close', dmOwner: 'close' } });
    const panel = t.store.getPanel(t.panel.id)!;
    const ticket = await t.service.open({ panel, owner: t.owner, actor: t.owner });
    await t.service.close(ticket, t.staff);
    expect(t.transcripts.sent).toHaveLength(1);
    expect(t.transcripts.sent[0].files).toHaveLength(1);
    expect(t.owner.user.dms).toHaveLength(1);
  });
});

describe('automations', () => {
  const rule = (value: object) => ({ name: 'Rule', windowSeconds: 600, ...value });

  it('closes a quiet ticket when its window ends', async () => {
    const t = setup({ automation: { rules: [rule({ kind: 'messageCheck', checkType: 'notFound', action: { type: 'close' } })] } });
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    await t.service.automation.tick(Date.now() + 601_000);
    expect(t.store.getTicket(ticket.id)!.state).toBe('closed');
  });

  it('runs delayed triggers after a ticket closes, and cancels them on reopen', async () => {
    const t = setup({ automation: { rules: [rule({ kind: 'trigger', event: 'closed', delaySeconds: 3600, action: { type: 'delete' } })] } });
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    await t.service.close(ticket, t.staff);
    await t.service.automation.tick(Date.now() + 60_000);
    expect(t.store.getTicket(ticket.id)!.state).toBe('closed');
    await t.service.reopen(t.store.getTicket(ticket.id)!, t.staff);
    expect(t.store.ticketJobs(ticket.id)).toHaveLength(0);
    await t.service.close(t.store.getTicket(ticket.id)!, t.staff);
    await t.service.automation.tick(Date.now() + 3_601_000);
    expect(t.store.getTicket(ticket.id)!.state).toBe('deleted');
  });

  it('closes tickets when the owner leaves', async () => {
    const t = setup({ automation: { missingUser: 'close' } });
    const ticket = await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    await t.service.automation.onOwnerLeft(ticket, t.panel);
    expect(t.store.getTicket(ticket.id)!.state).toBe('closed');
  });
});

describe('store', () => {
  it('keeps guild config between reads and writes', () => {
    const store = new Store(':memory:');
    const config = parseGuild({ general: { prefix: '!' } });
    store.saveGuild('1', config);
    expect(store.getGuild('1').general.prefix).toBe('!');
  });
  it('reports statistics', async () => {
    const t = setup();
    await t.service.open({ panel: t.panel, owner: t.owner, actor: t.owner });
    const stats = t.store.stats(t.guild.id);
    expect(stats.panels[0]).toMatchObject({ total: 1, open: 1, closed: 0 });
    expect(stats.activity).toHaveLength(1);
  });
});
