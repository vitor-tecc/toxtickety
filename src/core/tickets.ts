import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  OverwriteType,
  PermissionFlagsBits,
  RateLimitError,
  StringSelectMenuBuilder,
  ThreadAutoArchiveDuration,
  type CategoryChannel,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type MessageActionRowComponentBuilder,
  type OverwriteResolvable,
  type Role,
  type TextChannel,
  type ThreadChannel,
  type User,
} from 'discord.js';
import type {
  ButtonConfig,
  CustomCommand,
  GuildConfig,
  MessageTemplate,
  PanelConfig,
} from '../config/schema.js';
import type { LimitReason, Panel, Store, Ticket } from '../db/store.js';
import { buildOverwrites, type Actor } from './access.js';
import { AutomationEngine } from './automation.js';
import type { CommandMatch } from './customCommands.js';
import { explainDiscordError, UserError } from './errors.js';
import { isEmptyMessage, renderMessage } from './render.js';
import { isWithinSchedule } from './schedule.js';
import { renderTranscript, type TranscriptMessage } from './transcript.js';
import { toChannelName, renderVariables, type PersonVars, type VariableContext } from './variables.js';

export type TicketChannel = TextChannel | ThreadChannel;
type Components = ActionRowBuilder<MessageActionRowComponentBuilder>[];
type Trigger = 'close' | 'delete';

export const CustomIds = {
  create: 'tx:create:',
  form: 'tx:form:',
  select: 'tx:select',
  close: 'tx:close',
  claim: 'tx:claim',
  confirmClose: 'tx:close-confirm',
  cancelClose: 'tx:close-cancel',
  reopen: 'tx:reopen',
  delete: 'tx:delete',
  transcript: 'tx:transcript',
  escalate: 'tx:escalate',
} as const;

const LIMIT_MESSAGES: Record<LimitReason, string> = {
  global: 'You have reached the maximum number of open tickets on this server.',
  openPerUser: 'You already have the maximum number of open tickets in this panel.',
  openTotal: 'This panel has too many open tickets right now. Please try again later.',
  closedPerUser: 'You have too many closed tickets in this panel. Please wait for staff to remove them.',
  closedTotal: 'This panel has too many closed tickets right now. Please try again later.',
};

const CATEGORY_CAPACITY = 50;
const RENAME_WINDOW_MS = 10 * 60_000;
const RENAMES_PER_WINDOW = 2;

/** Discord allows two channel renames every ten minutes. Extra renames are skipped, not queued. */
export class RenameGuard {
  private readonly history = new Map<string, number[]>();

  allow(channelId: string, now = Date.now()): boolean {
    const recent = (this.history.get(channelId) ?? []).filter((at) => now - at < RENAME_WINDOW_MS);
    if (recent.length >= RENAMES_PER_WINDOW) {
      this.history.set(channelId, recent);
      return false;
    }
    recent.push(now);
    this.history.set(channelId, recent);
    return true;
  }
}

const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
} as const;

export function parseEmoji(value: string): { id?: string; name?: string; animated?: boolean } | null {
  const text = value.trim();
  if (!text) return null;
  const custom = /^<(a)?:?(\w{2,32}):(\d{17,20})>$/.exec(text);
  if (custom) return { id: custom[3]!, name: custom[2]!, animated: custom[1] === 'a' };
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text) ? { name: text } : null;
}

export function makeButton(config: ButtonConfig, customId: string): ButtonBuilder {
  const button = new ButtonBuilder().setCustomId(customId).setStyle(BUTTON_STYLES[config.style]);
  const emoji = parseEmoji(config.emoji);
  if (emoji) button.setEmoji(emoji);
  if (config.label) button.setLabel(config.label);
  else if (!emoji) button.setLabel('Button');
  return button;
}

function rows(buttons: ButtonBuilder[], perRow = 5): Components {
  const result: Components = [];
  for (let index = 0; index < buttons.length && result.length < 5; index += perRow) {
    result.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(buttons.slice(index, index + perRow)),
    );
  }
  return result;
}

const attempt = async <T>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await action();
  } catch (error) {
    console.warn(`[tickets] ${label} failed:`, explainDiscordError(error) ?? error);
    return undefined;
  }
};

const fail = (error: unknown, fallback: string): UserError => {
  if (error instanceof UserError) return error;
  console.error(`[tickets] ${fallback}`, error);
  return new UserError(explainDiscordError(error) ?? fallback);
};

export interface OpenOptions {
  panel: Panel;
  owner: GuildMember;
  actor: GuildMember;
  reason?: string | null;
  form?: string[];
}

export class TicketService {
  readonly renames = new RenameGuard();
  readonly automation: AutomationEngine;

  constructor(
    readonly client: Client,
    readonly store: Store,
    private readonly deleteDelayMs = 5000,
  ) {
    this.automation = new AutomationEngine(this);
  }

  // Access ---------------------------------------------------------------------------------------

  isAdmin(member: GuildMember, guild: GuildConfig = this.store.getGuild(member.guild.id)): boolean {
    return (
      member.id === member.guild.ownerId ||
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      guild.general.dashboardRoles.some((role) => member.roles.cache.has(role))
    );
  }

  isBlacklisted(member: GuildMember, guild: GuildConfig = this.store.getGuild(member.guild.id)): boolean {
    return guild.general.blacklistRoles.some((role) => member.roles.cache.has(role));
  }

  /** With a panel, checks that panel's team. Without one, any panel's team counts. */
  isSupport(member: GuildMember, panel?: Panel): boolean {
    if (this.isAdmin(member)) return true;
    const panels = panel ? [panel] : this.store.listPanels(member.guild.id);
    return panels.some((item) => item.config.general.supportRoles.some((role) => member.roles.cache.has(role)));
  }

  actor(member: GuildMember, panel?: Panel): Actor {
    return {
      roles: [...member.roles.cache.keys()],
      isAdmin: this.isAdmin(member),
      isSupport: this.isSupport(member, panel),
    };
  }

  /** Enforces "only the claimer and owner can use ticket actions". */
  assertTicketAction(ticket: Ticket, panel: Panel, member: GuildMember): void {
    if (!panel.config.claiming.enabled || !panel.config.claiming.restrictActions || !ticket.claimedBy) return;
    if (member.id === this.client.user?.id) return;
    if (this.isAdmin(member) || member.id === ticket.claimedBy || member.id === ticket.ownerId) return;
    throw new UserError('Only the member who claimed this ticket or its owner can do that.');
  }

  panelOf(ticket: Ticket): Panel {
    const panel = this.store.getPanel(ticket.panelId);
    if (!panel) throw new UserError('The panel for this ticket no longer exists.');
    return panel;
  }

  // Variables ------------------------------------------------------------------------------------

  private person(subject: GuildMember | User): PersonVars {
    const user = 'user' in subject ? subject.user : subject;
    const nickname = 'user' in subject ? subject.displayName : user.displayName;
    return {
      id: user.id,
      name: user.username,
      nickname,
      icon: subject.displayAvatarURL({ size: 256 }),
      discriminator: user.discriminator,
    };
  }

  private async ownerOf(guild: Guild, ownerId: string): Promise<GuildMember | User | null> {
    return (
      (await guild.members.fetch(ownerId).catch(() => null)) ??
      (await this.client.users.fetch(ownerId).catch(() => null))
    );
  }

  async context(
    guild: Guild,
    options: {
      ticket?: Ticket;
      panel?: Panel;
      author?: GuildMember | User | null;
      channel?: { id: string; name: string } | null;
      extra?: Partial<VariableContext>;
    } = {},
  ): Promise<VariableContext> {
    const { ticket, panel, author, channel, extra } = options;
    const owner = ticket ? await this.ownerOf(guild, ticket.ownerId) : null;
    const fresh = panel ? (this.store.getPanel(panel.id) ?? panel) : undefined;
    return {
      server: {
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL({ size: 512 }) ?? '',
        banner: guild.bannerURL({ size: 1024 }) ?? '',
      },
      channel: channel ? { id: channel.id, name: channel.name } : undefined,
      panel: fresh && {
        name: fresh.name,
        count: fresh.count,
        ticketLimit: fresh.config.limits.openPerUser,
        padding: fresh.config.general.padding,
      },
      ticket: ticket && {
        channelId: ticket.channelId ?? '',
        number: ticket.number,
        createdAt: ticket.createdAt,
        claimedAt: ticket.claimedAt,
        closedAt: ticket.closedAt,
        reopenedAt: ticket.reopenedAt,
        deletedAt: ticket.deletedAt,
      },
      owner: owner ? this.person(owner) : undefined,
      author: author ? this.person(author) : undefined,
      claimUserId: ticket?.claimedBy,
      createReason: ticket?.createReason,
      closeReason: ticket?.closeReason,
      deleteReason: ticket?.deleteReason,
      claimReason: ticket?.claimReason,
      form: ticket?.form,
      roleIdByName: (name) => guild.roles.cache.find((role) => role.name === name)?.id,
      ...extra,
    };
  }

  private async ticketContext(
    ticket: Ticket,
    panel: Panel,
    channel: TicketChannel,
    author: GuildMember | User | null,
    extra?: Partial<VariableContext>,
  ): Promise<VariableContext> {
    return this.context(channel.guild, { ticket, panel, author, channel, extra });
  }

  // Channels -------------------------------------------------------------------------------------

  async channelOf(guild: Guild, ticket: Ticket): Promise<TicketChannel | null> {
    if (!ticket.channelId) return null;
    const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
    if (!channel) return null;
    return channel.isThread() || channel.type === ChannelType.GuildText ? (channel as TicketChannel) : null;
  }

  private async requireChannel(guild: Guild, ticket: Ticket): Promise<TicketChannel> {
    const channel = await this.channelOf(guild, ticket);
    if (!channel) throw new UserError('The channel for this ticket no longer exists.');
    return channel;
  }

  /** Returns the first listed category with room, or undefined when none has any. */
  private async pickCategory(guild: Guild, ids: string[]): Promise<CategoryChannel | undefined> {
    if (ids.length === 0) return undefined;
    const all = await guild.channels.fetch();
    for (const id of ids) {
      const category = all.get(id);
      if (category?.type !== ChannelType.GuildCategory) continue;
      if (all.filter((channel) => channel?.parentId === id).size < CATEGORY_CAPACITY) return category;
    }
    return undefined;
  }

  private async overwrites(
    guild: Guild,
    ticket: Ticket,
    config: PanelConfig,
    state: 'open' | 'closed',
  ): Promise<OverwriteResolvable[]> {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const owner = await guild.members.fetch(ticket.ownerId).catch(() => null);
    const panelForOwner = config.general.supportRoles;
    const ownerIsSupport = owner ? panelForOwner.some((role) => owner.roles.cache.has(role)) : false;

    const list = buildOverwrites({
      guildId: guild.id,
      botId: me.id,
      config,
      state,
      ownerId: ticket.ownerId,
      ownerIsSupport,
      addedUsers: ticket.addedUsers,
      addedRoles: ticket.addedRoles,
      claimedBy: ticket.claimedBy,
    });

    const held = (names: (keyof typeof PermissionFlagsBits)[]) =>
      names.filter((name) => me.permissions.has(PermissionFlagsBits[name])).map((name) => PermissionFlagsBits[name]);

    const result: OverwriteResolvable[] = [];
    for (const entry of list) {
      if (entry.type === 'role' && !guild.roles.cache.has(entry.id)) continue;
      if (entry.type === 'member' && !(await guild.members.fetch(entry.id).catch(() => null))) continue;
      result.push({
        id: entry.id,
        type: entry.type === 'role' ? OverwriteType.Role : OverwriteType.Member,
        allow: held(entry.allow),
        deny: held(entry.deny),
      });
    }
    return result;
  }

  /** Applies a rename, category move and permission change in a single request. */
  private async applyChannel(
    channel: TextChannel,
    ticket: Ticket,
    config: PanelConfig,
    change: { name?: string; parent?: CategoryChannel; state?: 'open' | 'closed' },
  ): Promise<void> {
    const edit: Parameters<TextChannel['edit']>[0] = {};
    if (change.parent && channel.parentId !== change.parent.id) {
      edit.parent = change.parent.id;
      edit.lockPermissions = false;
    }
    if (change.state) edit.permissionOverwrites = await this.overwrites(channel.guild, ticket, config, change.state);

    const name = change.name ? toChannelName(change.name) : undefined;
    const wantsRename = Boolean(name && name !== channel.name && this.renames.allow(channel.id));
    if (wantsRename) edit.name = name;
    if (Object.keys(edit).length === 0) return;

    try {
      await channel.edit(edit);
    } catch (error) {
      if (!(error instanceof RateLimitError) || !wantsRename) throw error;
      delete edit.name;
      if (Object.keys(edit).length > 0) await channel.edit(edit);
    }
  }

  private async sendTemplate(
    channel: { send: TextChannel['send'] },
    template: MessageTemplate,
    ctx: VariableContext,
    components: Components = [],
  ): Promise<Message | undefined> {
    const rendered = renderMessage(template, ctx);
    if (isEmptyMessage(rendered) && components.length === 0) return undefined;
    return channel.send({ ...rendered, content: rendered.content || (rendered.embeds.length ? '' : '​'), components });
  }

  private async applyRoles(guild: Guild, userId: string, change: { add: string[]; remove: string[] }): Promise<void> {
    if (change.add.length === 0 && change.remove.length === 0) return;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;
    await attempt('adding roles', async () => {
      if (change.add.length) await member.roles.add(change.add);
    });
    await attempt('removing roles', async () => {
      if (change.remove.length) await member.roles.remove(change.remove);
    });
  }

  private async dmOwner(guild: Guild, ticket: Ticket, template: MessageTemplate, ctx: VariableContext): Promise<void> {
    await attempt('sending a DM', async () => {
      const user = await this.client.users.fetch(ticket.ownerId);
      const rendered = renderMessage(template, ctx);
      if (!isEmptyMessage(rendered)) await user.send(rendered);
    });
  }

  // Panels ---------------------------------------------------------------------------------------

  panelPayload(panel: Panel, ctx: VariableContext) {
    const { panel: settings } = panel.config;
    const rendered = renderMessage(settings.message, ctx);
    const components: Components = [];

    if (settings.dropdown.enabled) {
      const options = settings.dropdown.options
        .map((option) => ({ option, target: this.store.getPanel(option.panelId) }))
        .filter(({ target }) => target?.guildId === panel.guildId)
        .slice(0, 25)
        .map(({ option }) => {
          const emoji = parseEmoji(option.emoji);
          return {
            label: option.display,
            value: String(option.panelId),
            ...(option.description ? { description: option.description } : {}),
            ...(emoji ? { emoji } : {}),
          };
        });
      if (options.length === 0) throw new UserError('Add at least one dropdown option to this panel first.');
      components.push(
        new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(CustomIds.select)
            .setPlaceholder(settings.dropdown.placeholder || 'Select a ticket type')
            .addOptions(options),
        ),
      );
    } else {
      const attached = settings.attachedPanels
        .filter((id) => id !== panel.id)
        .map((id) => this.store.getPanel(id))
        .filter((item): item is Panel => item?.guildId === panel.guildId);
      const buttons = [panel, ...attached]
        .filter((item) => item.config.buttons.create.show)
        .slice(0, 25)
        .map((item) => makeButton(item.config.buttons.create, `${CustomIds.create}${item.id}`));
      if (buttons.length === 0) throw new UserError('This panel has no visible create button.');
      components.push(...rows(buttons, settings.buttonsPerRow));
    }

    return { ...rendered, content: rendered.content || (rendered.embeds.length ? '' : '​'), components };
  }

  async sendPanel(panel: Panel, channel: TextChannel): Promise<Message> {
    const ctx = await this.context(channel.guild, { panel, channel });
    try {
      return await channel.send(this.panelPayload(panel, ctx));
    } catch (error) {
      throw fail(error, 'I could not send the panel to that channel.');
    }
  }

  // Creating -------------------------------------------------------------------------------------

  private limitsFor(member: GuildMember, panel: Panel) {
    const cfg = panel.config.limits;
    const has = (roles: string[]) => roles.some((role) => member.roles.cache.has(role));
    return {
      globalLimit: this.store.getGuild(member.guild.id).general.globalTicketLimit,
      bypassOpen: has(cfg.openBypassRoles),
      bypassClosed: has(cfg.closedBypassRoles),
    };
  }

  private outsideHours(member: GuildMember, panel: Panel): boolean {
    const { schedule } = panel.config.limits;
    if (!schedule.enabled || schedule.bypassRoles.some((role) => member.roles.cache.has(role))) return false;
    return !isWithinSchedule(schedule, new Date());
  }

  /** Fast check run before showing a form, so nobody fills one in only to be turned away. */
  async assertCanOpen(member: GuildMember, panel: Panel): Promise<void> {
    if (this.isBlacklisted(member)) throw new UserError('You are not allowed to open tickets on this server.');
    const { schedule } = panel.config.limits;
    if (this.outsideHours(member, panel) && !schedule.replaceTicketMessage) {
      const ctx = await this.context(member.guild, { panel, author: member });
      const rendered = renderMessage(schedule.message, ctx);
      throw new UserError(rendered.content || rendered.embeds[0]?.description || 'This panel is currently closed.');
    }
    const problem = this.store.limitProblem(panel, member.id, this.limitsFor(member, panel));
    if (problem) throw new UserError(LIMIT_MESSAGES[problem]);
  }

  private async createChannel(guild: Guild, panel: Panel, ticket: Ticket, name: string): Promise<TicketChannel> {
    const { config } = panel;
    if (config.threadStyle.enabled) {
      const parent = await guild.channels.fetch(config.threadStyle.parentChannel).catch(() => null);
      if (parent?.type !== ChannelType.GuildText) {
        throw new UserError('This panel needs a valid text channel to create ticket threads under.');
      }
      const thread = await parent.threads.create({
        name,
        type: ChannelType.PrivateThread,
        invitable: config.threadStyle.nonModsCanInvite,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      });
      await thread.members.add(ticket.ownerId);
      return thread;
    }

    const wanted = [config.category.opened, ...config.category.overflow].filter(Boolean);
    const parent = await this.pickCategory(guild, wanted);
    if (wanted.length > 0 && !parent) {
      throw new UserError('Every ticket category for this panel is full or missing. Please tell an admin.');
    }
    return guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: parent?.id,
      permissionOverwrites: await this.overwrites(guild, ticket, config, 'open'),
    });
  }

  async open({ panel, owner, actor, reason = null, form = [] }: OpenOptions): Promise<Ticket> {
    const guild = owner.guild;
    await this.assertCanOpen(owner, panel);

    const reservation = this.store.reserveTicket(
      panel,
      owner.id,
      this.limitsFor(owner, panel),
      panel.config.threadStyle.enabled,
    );
    if (!reservation.ok) throw new UserError(LIMIT_MESSAGES[reservation.reason]);

    let channel: TicketChannel;
    try {
      const nameCtx = await this.context(guild, { ticket: reservation.ticket, panel, author: actor });
      const name = toChannelName(renderVariables(panel.config.ticket.openedName, nameCtx));
      channel = await this.createChannel(guild, panel, reservation.ticket, name);
    } catch (error) {
      this.store.dropTicket(reservation.ticket.id);
      throw fail(error, 'I could not create the ticket channel.');
    }

    const ticket = this.store.activateTicket(reservation.ticket.id, channel.id, form, reason);
    await this.welcome(ticket, panel, channel, owner, actor);
    return ticket;
  }

  /** Everything after the channel exists. Each step can fail without losing the ticket. */
  private async welcome(
    ticket: Ticket,
    panel: Panel,
    channel: TicketChannel,
    owner: GuildMember,
    actor: GuildMember,
  ): Promise<void> {
    const { config } = panel;
    const guild = channel.guild;
    const ctx = await this.ticketContext(ticket, panel, channel, actor, { reason: ticket.createReason });

    if (ticket.isThread && config.threadStyle.autoAddTeam && config.general.supportRoles.length > 0) {
      await attempt('adding the team to the thread', () =>
        channel.send({
          content: config.general.supportRoles.map((role) => `<@&${role}>`).join(' '),
          allowedMentions: { parse: ['roles'] },
        }),
      );
    }

    const replaced = this.outsideHours(owner, panel) && config.limits.schedule.replaceTicketMessage;
    const template = replaced ? config.limits.schedule.message : config.ticket.message;
    const sent = await attempt('sending the ticket message', () =>
      this.sendTemplate(channel, template, ctx, this.ticketButtons(ticket, panel)),
    );
    if (sent && config.general.autoPin) await attempt('pinning the ticket message', () => sent.pin());

    if (config.form.enabled && config.form.autoDisplay && ticket.form.length > 0) {
      await attempt('showing the form answers', () => channel.send({ embeds: [this.formEmbed(ticket, config)], allowedMentions: { parse: [] } }));
    }

    if (config.ticket.privateThread.enabled && !ticket.isThread) {
      await attempt('creating the staff thread', () => this.createStaffThread(channel as TextChannel, config, ctx));
    }

    await this.applyRoles(guild, ticket.ownerId, config.ticket.openedRoles);
    if (config.automation.dmOnCreate) await this.dmOwner(guild, ticket, config.automation.createdDm, ctx);
    await this.log(panel, 'created', 'Ticket created', ticket, actor, channel);
    this.automation.onOpened(ticket, panel);
  }

  private formEmbed(ticket: Ticket, config: PanelConfig): EmbedBuilder {
    const fields = config.form.questions
      .map((question, index) => ({ name: question.title, value: (ticket.form[index] || 'No answer').slice(0, 1024) }))
      .slice(0, 5);
    return new EmbedBuilder().setTitle(config.form.title || 'Form answers').setColor(0x5865f2).addFields(fields);
  }

  private async createStaffThread(channel: TextChannel, config: PanelConfig, ctx: VariableContext): Promise<void> {
    const settings = config.ticket.privateThread;
    const thread = await channel.threads.create({
      name: toChannelName(renderVariables(settings.name, ctx), 'staff'),
      type: ChannelType.PrivateThread,
      invitable: settings.nonModsCanInvite,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    });
    if (settings.autoAddTeam && config.general.supportRoles.length > 0) {
      await thread.send({
        content: config.general.supportRoles.map((role) => `<@&${role}>`).join(' '),
        allowedMentions: { parse: ['roles'] },
      });
    }
  }

  private ticketButtons(ticket: Ticket, panel: Panel): Components {
    const { buttons, claiming } = panel.config;
    const list: ButtonBuilder[] = [];
    if (buttons.close.show) list.push(makeButton(buttons.close, CustomIds.close));
    if (claiming.enabled && !ticket.isThread && buttons.claim.show) list.push(makeButton(buttons.claim, CustomIds.claim));
    return rows(list);
  }

  private moderatorButtons(panel: Panel): Components {
    const { buttons } = panel.config;
    const list: ButtonBuilder[] = [];
    if (buttons.transcript.show) list.push(makeButton(buttons.transcript, CustomIds.transcript));
    if (buttons.reopen.show) list.push(makeButton(buttons.reopen, CustomIds.reopen));
    if (buttons.delete.show) list.push(makeButton(buttons.delete, CustomIds.delete));
    return rows(list);
  }

  // Closing --------------------------------------------------------------------------------------

  async sendCloseAsk(ticket: Ticket, panel: Panel, actor: GuildMember): Promise<void> {
    if (ticket.state !== 'open') throw new UserError('This ticket is already closed.');
    const channel = await this.requireChannel(actor.guild, ticket);
    const { buttons, ticket: settings } = panel.config;
    const list: ButtonBuilder[] = [];
    if (buttons.confirmClose.show) list.push(makeButton(buttons.confirmClose, CustomIds.confirmClose));
    if (buttons.cancelClose.show) list.push(makeButton(buttons.cancelClose, CustomIds.cancelClose));
    const ctx = await this.ticketContext(ticket, panel, channel, actor);
    await this.sendTemplate(channel, settings.closeAskMessage, ctx, rows(list));
    this.automation.onEvent(ticket, panel, 'closeAsk');
  }

  async close(ticket: Ticket, actor: GuildMember, reason: string | null = null): Promise<void> {
    const panel = this.panelOf(ticket);
    if (!panel.config.general.twoStepTicket) {
      await this.delete(ticket, actor, reason);
      return;
    }
    const guild = actor.guild;
    const channel = await this.requireChannel(guild, ticket);
    const closedAt = Date.now();
    if (!this.store.transition(ticket.id, ['open'], 'closed', { closedAt, closeReason: reason })) {
      throw new UserError('This ticket is already closed.');
    }
    const closed = this.store.getTicket(ticket.id)!;
    const { config } = panel;

    try {
      const ctx = await this.ticketContext(closed, panel, channel, actor);
      await this.lockChannel(channel, closed, config, renderVariables(config.ticket.closedName, ctx));
    } catch (error) {
      this.store.transition(ticket.id, ['closed'], 'open', { closedAt: null, closeReason: null });
      throw fail(error, 'I could not close this ticket.');
    }

    this.automation.onClosed(closed, panel);
    const ctx = await this.ticketContext(closed, panel, channel, actor, { reason });
    await attempt('sending the closed message', () => this.sendTemplate(channel, config.moderator.closedMessage, ctx));
    const moderator = await attempt('sending the moderator message', () =>
      this.sendTemplate(channel, config.moderator.moderatorMessage, ctx, this.moderatorButtons(panel)),
    );
    if (moderator) this.store.patchTicket(closed.id, { modMessageId: moderator.id });

    await this.applyRoles(guild, closed.ownerId, config.ticket.closedRoles);
    if (config.automation.dmOnClose) await this.dmOwner(guild, closed, config.automation.closedDm, ctx);
    await this.autoTranscripts(closed, panel, channel, 'close');
    await this.log(panel, 'closed', 'Ticket closed', closed, actor, channel, reason);
  }

  private async lockChannel(channel: TicketChannel, ticket: Ticket, config: PanelConfig, name: string): Promise<void> {
    if (channel.isThread()) {
      await channel.setLocked(true);
      for (const id of [ticket.ownerId, ...ticket.addedUsers]) {
        await attempt('removing a member from the thread', () => channel.members.remove(id));
      }
      if (this.renames.allow(channel.id)) {
        await attempt('renaming the thread', async () => {
          await channel.setName(toChannelName(name));
        });
      }
      return;
    }
    const parent = config.category.closed ? await this.pickCategory(channel.guild, [config.category.closed]) : undefined;
    await this.applyChannel(channel as TextChannel, ticket, config, { name, parent, state: 'closed' });
  }

  async reopen(ticket: Ticket, actor: GuildMember): Promise<void> {
    const panel = this.panelOf(ticket);
    this.assertTicketAction(ticket, panel, actor);
    const channel = await this.requireChannel(actor.guild, ticket);
    const reopenedAt = Date.now();
    if (!this.store.transition(ticket.id, ['closed'], 'open', { reopenedAt })) {
      throw new UserError('This ticket is not closed.');
    }
    const opened = this.store.getTicket(ticket.id)!;
    const { config } = panel;

    try {
      const ctx = await this.ticketContext(opened, panel, channel, actor);
      const template = opened.claimedBy && config.claiming.nameEnabled ? config.claiming.name : config.ticket.openedName;
      const name = renderVariables(template, ctx);
      if (channel.isThread()) {
        await channel.setLocked(false);
        for (const id of [opened.ownerId, ...opened.addedUsers]) {
          await attempt('adding a member to the thread', () => channel.members.add(id));
        }
        if (this.renames.allow(channel.id)) {
        await attempt('renaming the thread', async () => {
          await channel.setName(toChannelName(name));
        });
      }
      } else {
        const wanted = config.category.closed ? [config.category.opened, ...config.category.overflow].filter(Boolean) : [];
        const parent = await this.pickCategory(actor.guild, wanted);
        await this.applyChannel(channel as TextChannel, opened, config, { name, parent, state: 'open' });
      }
    } catch (error) {
      this.store.transition(ticket.id, ['open'], 'closed', { reopenedAt: ticket.reopenedAt });
      throw fail(error, 'I could not reopen this ticket.');
    }

    if (ticket.modMessageId) {
      const id = ticket.modMessageId;
      await attempt('removing the moderator message', async () => {
        await channel.messages.delete(id);
      });
      this.store.patchTicket(ticket.id, { modMessageId: null });
    }
    const ctx = await this.ticketContext(opened, panel, channel, actor);
    await attempt('sending the reopened message', () => this.sendTemplate(channel, config.moderator.openedMessage, ctx));
    await this.log(panel, 'reopened', 'Ticket reopened', opened, actor, channel);
    this.automation.onReopened(opened, panel);
  }

  async delete(ticket: Ticket, actor: GuildMember, reason: string | null = null): Promise<void> {
    const panel = this.panelOf(ticket);
    this.assertTicketAction(ticket, panel, actor);
    const guild = actor.guild;
    const previous = ticket.state;
    const deletedAt = Date.now();
    if (!this.store.transition(ticket.id, ['open', 'closed'], 'deleting', { deletedAt, deleteReason: reason })) {
      throw new UserError('This ticket is already being deleted.');
    }
    this.automation.onDeleted(ticket);
    const current = this.store.getTicket(ticket.id)!;
    const channel = await this.channelOf(guild, current);
    if (!channel) {
      this.store.transition(ticket.id, ['deleting'], 'deleted');
      return;
    }
    const { config } = panel;
    const ctx = await this.ticketContext(current, panel, channel, actor, { reason });
    await attempt('sending the delete message', () => this.sendTemplate(channel, config.moderator.deleteMessage, ctx));
    await this.autoTranscripts(current, panel, channel, 'delete');
    if (previous === 'open') await this.applyRoles(guild, current.ownerId, config.ticket.closedRoles);
    await this.log(panel, 'deleted', 'Ticket deleted', current, actor, channel, reason);

    await new Promise((resolve) => setTimeout(resolve, this.deleteDelayMs));
    try {
      await channel.delete(`Ticket deleted by ${actor.user.username}`);
      this.store.transition(ticket.id, ['deleting'], 'deleted');
    } catch (error) {
      if ((error as { code?: number }).code === 10003) {
        this.store.transition(ticket.id, ['deleting'], 'deleted');
        return;
      }
      this.store.transition(ticket.id, ['deleting'], previous, { deletedAt: null, deleteReason: null });
      throw fail(error, 'I could not delete this channel.');
    }
  }

  /** Finishes deletes that were interrupted by a restart. */
  async finishInterruptedDeletes(): Promise<void> {
    for (const ticket of this.store.listTicketsInState('deleting')) {
      const guild = this.client.guilds.cache.get(ticket.guildId);
      const channel = guild ? await this.channelOf(guild, ticket) : null;
      if (channel) {
        await attempt('finishing a delete', async () => {
          await channel.delete('Ticket deleted');
        });
      }
      this.store.transition(ticket.id, ['deleting'], 'deleted');
    }
  }

  /** Marks tickets whose channels were removed while the bot was offline. */
  async reconcile(): Promise<void> {
    for (const ticket of this.store.listLiveTickets()) {
      const guild = this.client.guilds.cache.get(ticket.guildId);
      if (!guild || !ticket.channelId) continue;
      const missing = await guild.channels.fetch(ticket.channelId).then(
        () => false,
        (error: { code?: number }) => error.code === 10003,
      );
      if (missing) this.markChannelGone(ticket.channelId);
    }
  }

  markChannelGone(channelId: string): void {
    const ticket = this.store.getTicketByChannel(channelId);
    if (!ticket) return;
    this.automation.onDeleted(ticket);
    this.store.transition(ticket.id, ['open', 'closed', 'deleting'], 'deleted', {
      deletedAt: ticket.deletedAt ?? Date.now(),
    });
  }

  // Ticket actions -------------------------------------------------------------------------------

  async rename(ticket: Ticket, actor: GuildMember, name: string): Promise<string> {
    const channel = await this.requireChannel(actor.guild, ticket);
    const panel = this.panelOf(ticket);
    const ctx = await this.ticketContext(ticket, panel, channel, actor);
    const finalName = toChannelName(renderVariables(name, ctx));
    if (!this.renames.allow(channel.id)) {
      throw new UserError('Discord only allows 2 renames per channel every 10 minutes. Please try again later.');
    }
    try {
      await channel.setName(finalName);
    } catch (error) {
      if (error instanceof RateLimitError) {
        throw new UserError('Discord only allows 2 renames per channel every 10 minutes. Please try again later.');
      }
      throw fail(error, 'I could not rename this ticket.');
    }
    await this.log(panel, 'renamed', 'Ticket renamed', ticket, actor, channel, `New name: ${finalName}`);
    return finalName;
  }

  async addAccess(ticket: Ticket, actor: GuildMember, target: GuildMember | User | Role): Promise<void> {
    await this.changeAccess(ticket, actor, target, true);
  }

  async removeAccess(ticket: Ticket, actor: GuildMember, target: GuildMember | User | Role): Promise<void> {
    await this.changeAccess(ticket, actor, target, false);
  }

  private async changeAccess(
    ticket: Ticket,
    actor: GuildMember,
    target: GuildMember | User | Role,
    grant: boolean,
  ): Promise<void> {
    if (ticket.isThread) throw new UserError('Thread tickets manage members through the thread itself.');
    if (ticket.state !== 'open') throw new UserError('Reopen this ticket first.');
    const isRole = 'permissions' in target && 'hoist' in target;
    if (target.id === ticket.guildId) throw new UserError('You cannot change access for @everyone here.');
    if (!grant && target.id === ticket.ownerId) throw new UserError('You cannot remove the ticket owner.');
    const list = new Set(isRole ? ticket.addedRoles : ticket.addedUsers);
    if (grant && (list.has(target.id) || target.id === ticket.ownerId)) throw new UserError('They already have access.');
    if (!grant && !list.has(target.id)) throw new UserError('They were not added to this ticket.');
    if (grant) list.add(target.id);
    else list.delete(target.id);

    const users = isRole ? ticket.addedUsers : [...list];
    const roles = isRole ? [...list] : ticket.addedRoles;
    const updated = { ...ticket, addedUsers: users, addedRoles: roles };
    const channel = await this.requireChannel(actor.guild, ticket);
    try {
      await this.applyChannel(channel as TextChannel, updated, this.panelOf(ticket).config, { state: 'open' });
    } catch (error) {
      throw fail(error, 'I could not update access to this ticket.');
    }
    this.store.setAdded(ticket.id, users, roles);
  }

  // Claiming -------------------------------------------------------------------------------------

  private assertClaimable(ticket: Ticket, panel: Panel): void {
    if (!panel.config.claiming.enabled) throw new UserError('Claiming is turned off for this panel.');
    if (ticket.isThread) throw new UserError('Thread tickets cannot be claimed.');
    if (ticket.state !== 'open') throw new UserError('Only open tickets can be claimed.');
  }

  /** The Claim button: claims, takes over or releases depending on the ticket and settings. */
  async pressClaim(ticket: Ticket, actor: GuildMember): Promise<'claimed' | 'unclaimed'> {
    const panel = this.panelOf(ticket);
    this.assertClaimable(ticket, panel);
    if (ticket.claimedBy && (ticket.claimedBy === actor.id || !panel.config.claiming.overwriteClaim)) {
      await this.unclaim(ticket, actor);
      return 'unclaimed';
    }
    await this.claim(ticket, actor, actor);
    return 'claimed';
  }

  async claim(ticket: Ticket, actor: GuildMember, claimer: GuildMember, reason: string | null = null): Promise<void> {
    const panel = this.panelOf(ticket);
    this.assertClaimable(ticket, panel);
    const { claiming } = panel.config;
    if (ticket.claimedBy === claimer.id) throw new UserError('This ticket is already claimed by them.');
    if (ticket.claimedBy && !claiming.overwriteClaim) throw new UserError('This ticket is already claimed. Unclaim it first.');
    if (claimer.id === ticket.ownerId && !this.isSupport(claimer, panel)) {
      if (!claiming.allowOwnerClaim || claiming.changeSupportPermissions) {
        throw new UserError('Ticket owners cannot claim their own ticket.');
      }
    } else if (!this.isSupport(claimer, panel)) {
      throw new UserError('Only support team members can claim tickets.');
    }

    const claimedAt = Date.now();
    const updated: Ticket = { ...ticket, claimedBy: claimer.id, claimedAt, claimReason: reason };
    const channel = await this.requireChannel(actor.guild, ticket);
    const ctx = await this.ticketContext(updated, panel, channel, actor, { claimUserId: claimer.id });
    try {
      await this.applyChannel(channel as TextChannel, updated, panel.config, {
        name: claiming.nameEnabled ? renderVariables(claiming.name, ctx) : undefined,
        parent: await this.pickCategory(actor.guild, claiming.categories),
        state: 'open',
      });
    } catch (error) {
      throw fail(error, 'I could not claim this ticket.');
    }
    this.store.patchTicket(ticket.id, { claimedBy: claimer.id, claimedAt, claimReason: reason });
    await this.applyRoles(actor.guild, ticket.ownerId, claiming.claimedRoles);
    await attempt('sending the claimed message', () => this.sendTemplate(channel, claiming.claimedMessage, ctx));
    await this.log(panel, 'claimed', 'Ticket claimed', updated, actor, channel, `Claimed by <@${claimer.id}>`);
  }

  async unclaim(ticket: Ticket, actor: GuildMember): Promise<void> {
    const panel = this.panelOf(ticket);
    this.assertClaimable(ticket, panel);
    const { claiming, ticket: settings, category } = panel.config;
    if (!ticket.claimedBy) throw new UserError('This ticket is not claimed.');
    if (claiming.onlyClaimerCanUnclaim && ticket.claimedBy !== actor.id && !this.isAdmin(actor)) {
      throw new UserError('Only the member who claimed this ticket can unclaim it.');
    }

    const updated: Ticket = { ...ticket, claimedBy: null, claimedAt: null, claimReason: null };
    const channel = await this.requireChannel(actor.guild, ticket);
    const ctx = await this.ticketContext(updated, panel, channel, actor);
    const wanted = claiming.categories.length > 0 ? [category.opened, ...category.overflow].filter(Boolean) : [];
    try {
      await this.applyChannel(channel as TextChannel, updated, panel.config, {
        name: claiming.nameEnabled ? renderVariables(settings.openedName, ctx) : undefined,
        parent: await this.pickCategory(actor.guild, wanted),
        state: 'open',
      });
    } catch (error) {
      throw fail(error, 'I could not unclaim this ticket.');
    }
    this.store.patchTicket(ticket.id, { claimedBy: null, claimedAt: null, claimReason: null });
    await this.applyRoles(actor.guild, ticket.ownerId, claiming.unclaimedRoles);
    await attempt('sending the unclaimed message', () => this.sendTemplate(channel, claiming.unclaimedMessage, ctx));
    await this.log(panel, 'claimed', 'Ticket unclaimed', updated, actor, channel);
  }

  // Escalation -----------------------------------------------------------------------------------

  escalationTargets(ticket: Ticket, panel: Panel): Panel[] {
    if (ticket.isThread) throw new UserError('Thread tickets cannot be moved to another panel.');
    if (ticket.state !== 'open') throw new UserError('Only open tickets can be escalated.');
    const targets = panel.config.escalate.panels
      .filter((id) => id !== panel.id)
      .map((id) => this.store.getPanel(id))
      .filter((item): item is Panel => item?.guildId === panel.guildId);
    if (targets.length === 0) throw new UserError('Escalation is not set up for this panel.');
    return targets;
  }

  escalationMenu(targets: Panel[]): Components {
    return [
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(CustomIds.escalate)
          .setPlaceholder('Choose where to move this ticket')
          .addOptions(targets.slice(0, 25).map((target) => ({ label: target.name.slice(0, 100), value: String(target.id) }))),
      ),
    ];
  }

  rememberEscalationReason(ticket: Ticket, reason: string | null): void {
    this.store.patchTicket(ticket.id, { escalateReason: reason });
  }

  async escalate(ticket: Ticket, actor: GuildMember, target: Panel): Promise<void> {
    const source = this.panelOf(ticket);
    const allowed = this.escalationTargets(ticket, source);
    if (!allowed.some((item) => item.id === target.id)) throw new UserError('This ticket cannot be moved to that panel.');

    const settings = source.config.escalate;
    const channel = await this.requireChannel(actor.guild, ticket);
    const number = this.store.nextPanelNumber(target.id);
    const claimedBy = settings.autoUnclaim ? null : ticket.claimedBy;
    const updated: Ticket = { ...ticket, panelId: target.id, number, claimedBy };
    const fresh = this.store.getPanel(target.id)!;
    const ctx = await this.ticketContext(updated, fresh, channel, actor, {
      escalate: {
        from: source.name,
        to: fresh.name,
        reason: ticket.escalateReason ?? 'No reason provided',
        userId: actor.id,
      },
    });

    const wanted = [fresh.config.category.opened, ...fresh.config.category.overflow].filter(Boolean);
    try {
      await this.applyChannel(channel as TextChannel, updated, fresh.config, {
        name: settings.updateName ? renderVariables(fresh.config.ticket.openedName, ctx) : undefined,
        parent: settings.updateCategory ? await this.pickCategory(actor.guild, wanted) : undefined,
        state: settings.updatePermissions ? 'open' : undefined,
      });
    } catch (error) {
      throw fail(error, 'I could not move this ticket.');
    }

    this.store.patchTicket(ticket.id, {
      panelId: target.id,
      number,
      claimedBy,
      claimedAt: settings.autoUnclaim ? null : ticket.claimedAt,
      escalateReason: null,
    });
    await attempt('sending the escalation message', () => this.sendTemplate(channel, settings.customMessage, ctx));
    if (settings.sendTicketMessage) {
      await attempt('sending the ticket message', () =>
        this.sendTemplate(channel, fresh.config.ticket.message, ctx, this.ticketButtons(updated, fresh)),
      );
    }
    await this.log(source, 'escalated', 'Ticket escalated', updated, actor, channel, `Moved to ${fresh.name}`);
    this.automation.onEscalated(this.store.getTicket(ticket.id)!, fresh);
  }

  // Transcripts ----------------------------------------------------------------------------------

  private async collectMessages(channel: TicketChannel, max: number): Promise<TranscriptMessage[]> {
    const collected: Message[] = [];
    let before: string | undefined;
    while (collected.length < max) {
      const batch = await channel.messages.fetch({ limit: Math.min(100, max - collected.length), before, cache: false });
      if (batch.size === 0) break;
      collected.push(...batch.values());
      before = batch.last()?.id;
      if (batch.size < 100) break;
    }
    return collected.reverse().map((message) => ({
      id: message.id,
      authorName: message.member?.displayName ?? message.author.displayName,
      authorId: message.author.id,
      authorAvatar: message.author.displayAvatarURL({ size: 64 }),
      authorIsBot: message.author.bot,
      createdAt: message.createdTimestamp,
      editedAt: message.editedTimestamp,
      content: message.content,
      attachments: [...message.attachments.values()].map((file) => ({
        name: file.name,
        url: file.url,
        size: file.size,
        contentType: file.contentType,
      })),
      embeds: message.embeds.map((embed) => ({
        title: embed.title,
        description: embed.description,
        url: embed.url,
        color: embed.color,
        author: embed.author?.name ?? null,
        footer: embed.footer?.text ?? null,
        image: embed.image?.url ?? embed.thumbnail?.url ?? null,
        fields: embed.fields.map((field) => ({ name: field.name, value: field.value })),
      })),
      stickers: [...message.stickers.values()].map((sticker) => sticker.name),
    }));
  }

  private async buildTranscript(ticket: Ticket, panel: Panel, channel: TicketChannel, lines?: number) {
    const guild = channel.guild;
    const max = Math.min(lines ?? panel.config.transcript.maxMessages, panel.config.transcript.maxMessages);
    const messages = await this.collectMessages(channel, max);
    const owner = await this.ownerOf(guild, ticket.ownerId);
    const html = renderTranscript(messages, {
      serverName: guild.name,
      channelName: channel.name,
      panelName: panel.name,
      ownerName: owner ? this.person(owner).name : ticket.ownerId,
      ownerId: ticket.ownerId,
      generatedAt: Date.now(),
      resolveUser: (id) => guild.members.cache.get(id)?.displayName ?? this.client.users.cache.get(id)?.username,
      resolveRole: (id) => guild.roles.cache.get(id)?.name,
      resolveChannel: (id) => guild.channels.cache.get(id)?.name,
    });
    return { html, name: `${toChannelName(channel.name)}-transcript.html` };
  }

  /** Saves a transcript on request, either to the given channel or the panel's transcript channel. */
  async saveTranscript(
    ticket: Ticket,
    actor: GuildMember,
    options: { channelId?: string; lines?: number } = {},
  ): Promise<string> {
    const panel = this.panelOf(ticket);
    this.assertTicketAction(ticket, panel, actor);
    const targetId = options.channelId ?? panel.config.transcript.channel;
    if (!targetId) throw new UserError('Set a transcript channel for this panel first.');
    const channel = await this.requireChannel(actor.guild, ticket);
    try {
      const file = await this.buildTranscript(ticket, panel, channel, options.lines);
      await this.deliverTranscript(ticket, panel, channel, actor, targetId, file);
    } catch (error) {
      throw fail(error, 'I could not save the transcript.');
    }
    await this.log(panel, 'transcript', 'Transcript saved', ticket, actor, channel);
    return targetId;
  }

  private async deliverTranscript(
    ticket: Ticket,
    panel: Panel,
    channel: TicketChannel,
    actor: GuildMember | null,
    targetId: string,
    file: { html: string; name: string },
  ): Promise<void> {
    const target = await channel.guild.channels.fetch(targetId);
    if (!target?.isTextBased()) throw new UserError('The transcript channel is not a text channel.');
    const ctx = await this.ticketContext(ticket, panel, channel, actor);
    const rendered = renderMessage(panel.config.transcript.message, ctx);
    await target.send({ ...rendered, files: [new AttachmentBuilder(Buffer.from(file.html), { name: file.name })] });
  }

  private async autoTranscripts(ticket: Ticket, panel: Panel, channel: TicketChannel, trigger: Trigger): Promise<void> {
    const { autoSave, dmOwner, channel: targetId } = panel.config.transcript;
    const fires = (setting: string) => setting === 'both' || setting === trigger;
    const save = fires(autoSave) && Boolean(targetId);
    const dm = fires(dmOwner);
    if (!save && !dm) return;

    const file = await attempt('building the transcript', () => this.buildTranscript(ticket, panel, channel));
    if (!file) return;
    if (save) {
      await attempt('saving the transcript', () => this.deliverTranscript(ticket, panel, channel, null, targetId, file));
      await this.log(panel, 'transcript', 'Transcript saved', ticket, null, channel);
    }
    if (dm) {
      await attempt('sending the transcript by DM', async () => {
        const user = await this.client.users.fetch(ticket.ownerId);
        const ctx = await this.ticketContext(ticket, panel, channel, null);
        await user.send({
          ...renderMessage(panel.config.transcript.message, ctx),
          files: [new AttachmentBuilder(Buffer.from(file.html), { name: file.name })],
        });
      });
    }
  }

  // Custom commands ------------------------------------------------------------------------------

  async runCustomCommand(
    command: CustomCommand,
    options: {
      guild: Guild;
      channel: TextChannel | ThreadChannel;
      author: GuildMember;
      ticket?: Ticket;
      match?: CommandMatch;
    },
  ): Promise<void> {
    const { guild, channel, author, ticket, match } = options;
    const panel = ticket ? this.store.getPanel(ticket.panelId) : undefined;
    const ctx = await this.context(guild, {
      ticket,
      panel,
      author,
      channel,
      extra: { args: match?.args, regex: match?.regex },
    });
    const rendered = renderMessage(command.response, ctx);
    if (isEmptyMessage(rendered)) return;

    if (command.dmTicketOwner) {
      if (!ticket) return;
      await attempt('sending a custom command DM', async () => {
        const owner = await this.client.users.fetch(ticket.ownerId);
        await owner.send(rendered);
      });
    } else if (command.dmResponse) {
      await attempt('sending a custom command DM', async () => {
        await author.send(rendered);
      });
    } else {
      await channel.send(rendered);
    }
  }

  // Logging --------------------------------------------------------------------------------------

  private async log(
    panel: Panel,
    event: 'created' | 'closed' | 'reopened' | 'renamed' | 'deleted' | 'transcript' | 'claimed' | 'escalated',
    title: string,
    ticket: Ticket,
    actor: GuildMember | null,
    channel: TicketChannel,
    detail?: string | null,
  ): Promise<void> {
    const { logging } = panel.config;
    if (!logging.channel || !logging[event]) return;
    await attempt('writing to the log channel', async () => {
      const target = await channel.guild.channels.fetch(logging.channel);
      if (!target?.isTextBased()) return;
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(0x5865f2)
        .setTimestamp()
        .addFields(
          { name: 'Ticket', value: `${channel.name} (<#${channel.id}>)`, inline: true },
          { name: 'Panel', value: panel.name.slice(0, 1024), inline: true },
          { name: 'Owner', value: `<@${ticket.ownerId}>`, inline: true },
        );
      if (actor) embed.addFields({ name: 'By', value: `<@${actor.id}>`, inline: true });
      if (detail) embed.addFields({ name: 'Details', value: detail.slice(0, 1024) });
      await target.send({ embeds: [embed], allowedMentions: { parse: [] } });
    });
  }
}
