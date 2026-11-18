import {
  ActionRowBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type RateLimitData,
  type Role,
  type StringSelectMenuInteraction,
  type User,
} from 'discord.js';
import type { ButtonConfig, CommandName } from '../config/schema.js';
import type { Panel, Store, Ticket } from '../db/store.js';
import { evaluateButton, evaluateCommand } from '../core/access.js';
import { findCustomCommand } from '../core/customCommands.js';
import { explainDiscordError, UserError } from '../core/errors.js';
import { CustomIds, TicketService } from '../core/tickets.js';
import { parseArgs, type RawArg } from './args.js';
import {
  findCommand,
  slashDefinitions,
  type CommandArgs,
  type CommandChannel,
  type CommandContext,
  type CommandDef,
  type ReplyPayload,
} from './commands.js';

/**
 * Channel renames can be limited for up to ten minutes. Failing fast lets a ticket close on time
 * with its old name, rather than freezing until Discord allows the rename.
 */
export function shouldRejectRateLimit(limit: RateLimitData): boolean {
  const wait = Math.max(limit.timeToReset, limit.retryAfter, limit.sublimitTimeout);
  return limit.method === 'PATCH' && /^\/channels\/(:id|\d+)$/.test(limit.route) && wait > 5000;
}

export function createClient(status: string): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.GuildMember],
    presence: { activities: [{ name: status, type: 3 }] },
    rest: { rejectOnRateLimit: shouldRejectRateLimit },
  });
}

/** View, send, embed, attach, read history, manage channels, roles, messages and private threads. */
const INVITE_PERMISSIONS = new PermissionsBitField([
  'ViewChannel',
  'SendMessages',
  'EmbedLinks',
  'AttachFiles',
  'ReadMessageHistory',
  'ManageChannels',
  'ManageRoles',
  'ManageMessages',
  'ManageThreads',
  'CreatePrivateThreads',
  'SendMessagesInThreads',
]).bitfield.toString();

const isCommandChannel = (channel: unknown): channel is CommandChannel => {
  const value = channel as { type?: ChannelType; isThread?: () => boolean } | null;
  return value?.type === ChannelType.GuildText || value?.isThread?.() === true;
};

const describeError = (error: unknown): string => {
  if (error instanceof UserError) return error.message;
  const known = explainDiscordError(error);
  if (known) return known;
  console.error('[bot] unexpected error:', error);
  return 'Something went wrong. Please try again.';
};

export class Bot {
  readonly service: TicketService;

  constructor(
    readonly client: Client,
    readonly store: Store,
    private readonly devGuildId?: string,
  ) {
    this.service = new TicketService(client, store);
  }

  attach(): void {
    const guard = (label: string, task: Promise<unknown>) =>
      void task.catch((error: unknown) => console.error(`[bot] ${label}:`, error));

    this.client.once(Events.ClientReady, () => guard('startup', this.onReady()));
    this.client.on(Events.InteractionCreate, (interaction) => guard('interaction', this.onInteraction(interaction)));
    this.client.on(Events.MessageCreate, (message) => guard('message', this.onMessage(message)));
    this.client.on(Events.ChannelDelete, (channel) => this.service.markChannelGone(channel.id));
    this.client.on(Events.ThreadDelete, (thread) => this.service.markChannelGone(thread.id));
    this.client.on(Events.GuildMemberRemove, (member) => guard('member leave', this.onMemberLeft(member.guild.id, member.id)));
  }

  private async onReady(): Promise<void> {
    const user = this.client.user!;
    console.log(`[bot] logged in as ${user.tag}`);
    console.log(`[bot] invite link: https://discord.com/oauth2/authorize?client_id=${user.id}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}`);
    const definitions = slashDefinitions();
    if (this.devGuildId) await this.client.application!.commands.set(definitions, this.devGuildId);
    else await this.client.application!.commands.set(definitions);

    const stale = this.store.clearStaleReservations();
    if (stale > 0) console.log(`[bot] cleared ${stale} unfinished ticket(s)`);
    await this.service.finishInterruptedDeletes();
    await this.service.reconcile();
    this.service.automation.start();
    await this.service.automation.tick();
  }

  private async onMemberLeft(guildId: string, userId: string): Promise<void> {
    for (const ticket of this.store.listTicketsByOwner(guildId, userId)) {
      const panel = this.store.getPanel(ticket.panelId);
      if (!panel) continue;
      await this.service.automation
        .onOwnerLeft(ticket, panel)
        .catch((error: unknown) => console.warn(`[bot] could not update ticket ${ticket.id}:`, error));
    }
  }

  // Commands -------------------------------------------------------------------------------------

  /** Shared by slash and prefix commands, so both follow exactly the same rules. */
  private async execute(command: CommandDef, ctx: CommandContext): Promise<void> {
    const { service, member, channel, ticket, panel, guild } = ctx;
    try {
      const config = this.store.getGuild(guild.id);
      const isAdmin = service.isAdmin(member, config);
      if (service.isBlacklisted(member, config) && !isAdmin) throw new UserError('You are not allowed to use this bot.');
      if (command.adminOnly && !isAdmin) throw new UserError('Only server admins can use this command.');
      if (command.name !== 'setup') {
        const rule = config.commands[command.name as CommandName];
        const channelIds = [channel.id, channel.parentId ?? ''].filter(Boolean);
        const verdict = evaluateCommand(rule, service.actor(member, panel), channelIds);
        if (!verdict.allowed) throw new UserError(verdict.reason);
      }
      if (command.ticketOnly && (!ticket || !panel)) throw new UserError('Use this command inside a ticket.');
      await command.run(ctx);
    } catch (error) {
      await ctx.reply(describeError(error));
    }
  }

  private async onSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) return;
    const command = findCommand(interaction.commandName);
    if (!command) return;
    if (!isCommandChannel(interaction.channel)) {
      await interaction.reply({ content: 'Use this command in a text channel.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply(command.private ? { flags: MessageFlags.Ephemeral } : {});

    const options = interaction.options;
    const args: CommandArgs = {
      text: (name) => options.getString(name) ?? undefined,
      number: (name) => options.getInteger(name) ?? undefined,
      user: (name) => options.getMember(name) ?? options.getUser(name) ?? undefined,
      role: (name) => options.getRole(name) ?? undefined,
      mentionable: (name) => (options.getMentionable(name) as GuildMember | User | Role | null) ?? undefined,
      channel: (name) => options.getChannel(name) ?? undefined,
    };

    let replied = false;
    const reply = async (payload: string | ReplyPayload) => {
      const body = typeof payload === 'string' ? { content: payload } : payload;
      try {
        if (replied) await interaction.followUp({ ...body, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        else await interaction.editReply({ ...body, allowedMentions: { parse: [] } });
        replied = true;
      } catch {
        // The ticket channel may already be gone.
      }
    };

    const ticket = this.store.getTicketByChannel(interaction.channelId);
    await this.execute(command, {
      service: this.service,
      guild: interaction.guild,
      member: interaction.member,
      channel: interaction.channel,
      args,
      ticket,
      panel: ticket && this.store.getPanel(ticket.panelId),
      prefix: '/',
      isSlash: true,
      reply,
      deleteSource: async () => undefined,
    });
  }

  private async onMessage(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.id === this.client.user?.id) return;
    const config = this.store.getGuild(message.guildId);
    if (message.author.bot && !config.general.authorizedBots.includes(message.author.id)) return;
    if (message.webhookId || !isCommandChannel(message.channel)) return;

    const ticket = this.store.getTicketByChannel(message.channelId);
    if (ticket?.state === 'open') await this.service.automation.onMessage(ticket, message);

    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return;

    const mention = new RegExp(`^<@!?${this.client.user!.id}>\\s*`);
    const prefix = config.general.prefix;
    const body = mention.test(message.content)
      ? message.content.replace(mention, '')
      : message.content.startsWith(prefix)
        ? message.content.slice(prefix.length)
        : null;

    if (body !== null) {
      const name = /^\S+/.exec(body)?.[0] ?? '';
      const command = findCommand(name);
      if (command) {
        await this.onPrefixCommand(command, message, member, body.slice(name.length), prefix, ticket);
        return;
      }
    }
    await this.onCustomCommand(message, member, ticket);
  }

  private async onPrefixCommand(
    command: CommandDef,
    message: Message<true>,
    member: GuildMember,
    rawArgs: string,
    prefix: string,
    ticket: Ticket | undefined,
  ): Promise<void> {
    const reply = async (payload: string | ReplyPayload) => {
      const body = typeof payload === 'string' ? { content: payload } : payload;
      await message.reply({ ...body, allowedMentions: { parse: [], repliedUser: false } }).catch(() => undefined);
    };
    const parsed = parseArgs(command.options ?? [], rawArgs);
    if (!parsed.ok) {
      await reply(`Missing \`${parsed.missing}\`. Use \`${prefix}help\` to see how this command works.`);
      return;
    }
    const args = await this.resolveArgs(message, parsed.args);
    await this.execute(command, {
      service: this.service,
      guild: message.guild,
      member,
      channel: message.channel as CommandChannel,
      args,
      ticket,
      panel: ticket && this.store.getPanel(ticket.panelId),
      prefix,
      isSlash: false,
      reply,
      deleteSource: async () => {
        await message.delete().catch(() => undefined);
      },
    });
  }

  private async resolveArgs(message: Message<true>, raw: Record<string, RawArg>): Promise<CommandArgs> {
    const guild = message.guild;
    const resolved = new Map<string, GuildMember | User | Role | { id: string; type: ChannelType }>();
    for (const [name, arg] of Object.entries(raw)) {
      if (arg.kind === 'text' || arg.kind === 'number') continue;
      if (arg.kind === 'channel') {
        const channel = await guild.channels.fetch(arg.id).catch(() => null);
        if (channel) resolved.set(name, channel);
        continue;
      }
      const role = arg.kind === 'user' ? null : await guild.roles.fetch(arg.id).catch(() => null);
      const person =
        arg.kind === 'role' || role
          ? null
          : ((await guild.members.fetch(arg.id).catch(() => null)) ??
            (await this.client.users.fetch(arg.id).catch(() => null)));
      const value = role ?? person;
      if (value) resolved.set(name, value);
    }
    const isRole = (value: unknown): value is Role => Boolean(value && typeof value === 'object' && 'hoist' in value);
    const isChannel = (value: unknown) => Boolean(value && typeof value === 'object' && 'type' in value && !('hoist' in value) && !('username' in value) && !('user' in value));
    return {
      text: (name) => (raw[name]?.kind === 'text' ? raw[name].value : undefined),
      number: (name) => (raw[name]?.kind === 'number' ? raw[name].value : undefined),
      user: (name) => {
        const value = resolved.get(name);
        return value && !isRole(value) && !isChannel(value) ? (value as GuildMember | User) : undefined;
      },
      role: (name) => {
        const value = resolved.get(name);
        return isRole(value) ? value : undefined;
      },
      mentionable: (name) => {
        const value = resolved.get(name);
        return value && !isChannel(value) ? (value as GuildMember | User | Role) : undefined;
      },
      channel: (name) => {
        const value = resolved.get(name);
        return isChannel(value) ? (value as { id: string; type: ChannelType }) : undefined;
      },
    };
  }

  private async onCustomCommand(message: Message<true>, member: GuildMember, ticket: Ticket | undefined): Promise<void> {
    const config = this.store.getGuild(message.guildId);
    if (config.customCommands.length === 0 || this.service.isBlacklisted(member, config)) return;
    const found = findCustomCommand(config.customCommands, message.content);
    if (!found) return;
    if (found.command.adminOnly && !this.service.isAdmin(member, config)) return;
    await this.service.runCustomCommand(found.command, {
      guild: message.guild,
      channel: message.channel as CommandChannel,
      author: member,
      ticket,
      match: found.match,
    });
    if (found.command.deleteTrigger) await message.delete().catch(() => undefined);
  }

  // Components -----------------------------------------------------------------------------------

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.onSlash(interaction);
      return;
    }
    if (!interaction.inCachedGuild()) return;
    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
    if (!interaction.customId.startsWith('tx:')) return;

    try {
      if (interaction.isModalSubmit()) await this.onFormSubmit(interaction);
      else if (interaction.isStringSelectMenu()) await this.onSelect(interaction);
      else await this.onButton(interaction);
    } catch (error) {
      const content = describeError(error);
      const answer = interaction.deferred || interaction.replied
        ? interaction.editReply({ content, components: [] })
        : interaction.reply({ content, flags: MessageFlags.Ephemeral });
      await answer.catch(() => undefined);
    }
  }

  private panelInGuild(id: number, guildId: string): Panel {
    const panel = Number.isSafeInteger(id) ? this.store.getPanel(id) : undefined;
    if (panel?.guildId !== guildId) throw new UserError('This panel no longer exists.');
    return panel;
  }

  private async startTicket(interaction: ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>, panel: Panel) {
    const member = interaction.member;
    const verdict = evaluateButton(panel.config.buttons.create, this.service.actor(member, panel));
    if (!verdict.allowed) throw new UserError(verdict.reason);
    await this.service.assertCanOpen(member, panel);

    const { form } = panel.config;
    if (form.enabled && form.questions.length > 0) {
      const modal = new ModalBuilder().setCustomId(`${CustomIds.form}${panel.id}`).setTitle(form.title || 'Open a ticket');
      form.questions.slice(0, 5).forEach((question, index) => {
        const max = Math.max(1, question.maxLength);
        const input = new TextInputBuilder()
          .setCustomId(`q${index}`)
          .setLabel(question.title)
          .setStyle(question.multiline ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(question.required)
          .setMaxLength(max);
        if (question.minLength > 0) input.setMinLength(Math.min(question.minLength, max));
        if (question.placeholder) input.setPlaceholder(question.placeholder);
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      });
      await interaction.showModal(modal);
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ticket = await this.service.open({ panel, owner: member, actor: member });
    await interaction.editReply(`Ticket created: <#${ticket.channelId}>`);
  }

  private async onFormSubmit(interaction: ModalSubmitInteraction<'cached'>): Promise<void> {
    if (!interaction.customId.startsWith(CustomIds.form)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const panel = this.panelInGuild(Number(interaction.customId.slice(CustomIds.form.length)), interaction.guildId);
    const form = panel.config.form.questions
      .slice(0, 5)
      .map((_, index) => {
        try {
          return interaction.fields.getTextInputValue(`q${index}`);
        } catch {
          return '';
        }
      });
    const ticket = await this.service.open({ panel, owner: interaction.member, actor: interaction.member, form });
    await interaction.editReply(`Ticket created: <#${ticket.channelId}>`);
  }

  private async onSelect(interaction: StringSelectMenuInteraction<'cached'>): Promise<void> {
    const value = Number(interaction.values[0]);
    if (interaction.customId === CustomIds.select) {
      await this.startTicket(interaction, this.panelInGuild(value, interaction.guildId));
      return;
    }
    if (interaction.customId !== CustomIds.escalate) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ticket = this.requireTicket(interaction.channelId);
    const panel = this.service.panelOf(ticket);
    const rule = this.store.getGuild(interaction.guildId).commands.escalate;
    const verdict = evaluateCommand(rule, this.service.actor(interaction.member, panel), [interaction.channelId]);
    if (!verdict.allowed) throw new UserError(verdict.reason);
    const target = this.panelInGuild(value, interaction.guildId);
    await this.service.escalate(ticket, interaction.member, target);
    await interaction.message.delete().catch(() => undefined);
    await interaction.editReply(`Ticket moved to **${target.name}**.`);
  }

  private requireTicket(channelId: string): Ticket {
    const ticket = this.store.getTicketByChannel(channelId);
    if (!ticket) throw new UserError('This channel is no longer a ticket.');
    return ticket;
  }

  private async onButton(interaction: ButtonInteraction<'cached'>): Promise<void> {
    const { customId, member, guildId } = interaction;
    if (this.service.isBlacklisted(member) && !this.service.isAdmin(member)) {
      throw new UserError('You are not allowed to use this bot.');
    }
    if (customId.startsWith(CustomIds.create)) {
      await this.startTicket(interaction, this.panelInGuild(Number(customId.slice(CustomIds.create.length)), guildId));
      return;
    }

    const ticket = this.requireTicket(interaction.channelId);
    const panel = this.service.panelOf(ticket);
    const check = (button: ButtonConfig) => {
      const verdict = evaluateButton(button, this.service.actor(member, panel));
      if (!verdict.allowed) throw new UserError(verdict.reason);
    };
    const { buttons, general } = panel.config;

    switch (customId) {
      case CustomIds.close:
        check(buttons.close);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (general.twoStepClose) {
          await this.service.sendCloseAsk(ticket, panel, member);
          await interaction.deleteReply();
        } else {
          await interaction.editReply('Closing this ticket.');
          await this.service.close(ticket, member);
        }
        return;
      case CustomIds.confirmClose:
        check(buttons.confirmClose);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.message.delete().catch(() => undefined);
        await interaction.editReply('Closing this ticket.');
        await this.service.close(ticket, member);
        return;
      case CustomIds.cancelClose:
        check(buttons.cancelClose);
        await interaction.deferUpdate();
        await interaction.message.delete().catch(() => undefined);
        return;
      case CustomIds.reopen:
        check(buttons.reopen);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.service.reopen(ticket, member);
        await interaction.editReply('Ticket reopened.');
        return;
      case CustomIds.delete:
        check(buttons.delete);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply('Deleting this ticket.');
        await this.service.delete(ticket, member);
        return;
      case CustomIds.transcript: {
        check(buttons.transcript);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const target = await this.service.saveTranscript(ticket, member);
        await interaction.editReply(`Transcript saved to <#${target}>.`);
        return;
      }
      case CustomIds.claim: {
        check(buttons.claim);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await this.service.pressClaim(ticket, member);
        await interaction.editReply(result === 'claimed' ? 'Ticket claimed.' : 'Ticket unclaimed.');
        return;
      }
      default:
        return;
    }
  }
}
