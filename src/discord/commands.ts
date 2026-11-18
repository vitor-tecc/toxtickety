import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Guild,
  type GuildMember,
  type MessageActionRowComponentBuilder,
  type ActionRowBuilder,
  type Role,
  type TextChannel,
  type ThreadChannel,
  type User,
} from 'discord.js';
import { parsePanel, type CommandName } from '../config/schema.js';
import type { Panel, Ticket } from '../db/store.js';
import { UserError } from '../core/errors.js';
import type { TicketService } from '../core/tickets.js';
import type { OptionDef } from './args.js';

export type CommandChannel = TextChannel | ThreadChannel;

export interface ReplyPayload {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

export interface CommandArgs {
  text(name: string): string | undefined;
  number(name: string): number | undefined;
  user(name: string): GuildMember | User | undefined;
  role(name: string): Role | undefined;
  mentionable(name: string): GuildMember | User | Role | undefined;
  channel(name: string): { id: string; type: ChannelType } | undefined;
}

export interface CommandContext {
  service: TicketService;
  guild: Guild;
  member: GuildMember;
  channel: CommandChannel;
  args: CommandArgs;
  ticket?: Ticket;
  panel?: Panel;
  prefix: string;
  isSlash: boolean;
  reply(payload: string | ReplyPayload): Promise<void>;
  deleteSource(): Promise<void>;
}

export interface CommandDef {
  name: CommandName | 'setup';
  aliases?: string[];
  description: string;
  options?: OptionDef[];
  ticketOnly?: boolean;
  adminOnly?: boolean;
  private?: boolean;
  run(ctx: CommandContext): Promise<void>;
}

type InTicket = CommandContext & { ticket: Ticket; panel: Panel };
const inTicket = (ctx: CommandContext) => ctx as InTicket;

export function permissionLevel(service: TicketService, member: GuildMember): string {
  if (member.id === member.guild.ownerId) return 'Server owner';
  if (service.isAdmin(member)) return 'Admin';
  if (service.isBlacklisted(member)) return 'Blacklisted';
  if (service.isSupport(member)) return 'Support team';
  return 'Member';
}

const REQUIRED_PERMISSIONS = [
  'ViewChannel',
  'SendMessages',
  'EmbedLinks',
  'AttachFiles',
  'ReadMessageHistory',
  'ManageChannels',
  'ManageRoles',
  'ManageMessages',
  'CreatePrivateThreads',
  'SendMessagesInThreads',
  'ManageThreads',
] as const;

export const commands: CommandDef[] = [
  {
    name: 'help',
    description: 'Show every command',
    private: true,
    async run({ prefix, reply }) {
      const lines = commands.map((command) => {
        const options = (command.options ?? []).map((option) => (option.required ? `<${option.name}>` : `[${option.name}]`));
        return `\`${[prefix + command.name, ...options].join(' ')}\` ${command.description}`;
      });
      await reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Commands')
            .setColor(0x5865f2)
            .setDescription(lines.join('\n').slice(0, 4096))
            .setFooter({ text: 'Every command also works as a slash command.' }),
        ],
      });
    },
  },
  {
    name: 'debug',
    description: 'Show troubleshooting details for this channel',
    private: true,
    async run({ service, guild, channel, member, ticket, reply }) {
      const me = guild.members.me ?? (await guild.members.fetchMe());
      const held = channel.permissionsFor(me);
      const missing = REQUIRED_PERMISSIONS.filter((name) => !held.has(PermissionFlagsBits[name]));
      await reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Debug')
            .setColor(missing.length ? 0xed4245 : 0x57f287)
            .addFields(
              { name: 'Latency', value: `${service.client.ws.ping} ms`, inline: true },
              { name: 'Your level', value: permissionLevel(service, member), inline: true },
              { name: 'Panels', value: String(service.store.listPanels(guild.id).length), inline: true },
              { name: 'Ticket', value: ticket ? `#${ticket.number} (${ticket.state})` : 'Not a ticket', inline: true },
              { name: 'Missing bot permissions here', value: missing.join(', ') || 'None' },
            ),
        ],
      });
    },
  },
  {
    name: 'permissionlevel',
    aliases: ['level'],
    description: 'Show your permission level, or another member’s',
    options: [{ name: 'user', description: 'Member to check', type: 'user' }],
    private: true,
    async run({ service, guild, member, args, reply }) {
      const target = args.user('user');
      const subject = target ? await guild.members.fetch(target.id).catch(() => null) : member;
      if (!subject) throw new UserError('That user is not on this server.');
      await reply(`<@${subject.id}>: **${permissionLevel(service, subject)}**`);
    },
  },
  {
    name: 'ping',
    description: 'Show the bot latency',
    private: true,
    async run({ service, reply }) {
      await reply(`Pong: ${service.client.ws.ping} ms`);
    },
  },
  {
    name: 'setup',
    description: 'Create a ready-to-use ticket panel in this channel',
    adminOnly: true,
    private: true,
    options: [
      { name: 'support_role', description: 'Role that handles tickets', type: 'role' },
      { name: 'category', description: 'Category for new tickets', type: 'channel' },
      { name: 'name', description: 'Panel name', type: 'string' },
    ],
    async run({ service, guild, channel, member, args, reply }) {
      if (channel.isThread()) throw new UserError('Run this in a regular text channel.');
      const category = args.channel('category');
      if (category && category.type !== ChannelType.GuildCategory) throw new UserError('Choose a category for tickets.');
      const role = args.role('support_role');
      const name = (args.text('name') ?? 'Support').slice(0, 80);
      const panel = service.store.createPanel(
        guild.id,
        name,
        parsePanel({
          general: { supportRoles: role ? [role.id] : [] },
          category: { opened: category?.id ?? '' },
        }),
      );
      service.store.addAudit(guild.id, member.id, member.user.username, 'Created panel', name);
      await service.sendPanel(panel, channel as TextChannel);
      await reply(`Panel **${name}** is ready (ID ${panel.id}). Customize it from the dashboard.`);
    },
  },
  {
    name: 'panel',
    description: 'Send a panel to this channel',
    adminOnly: true,
    private: true,
    options: [{ name: 'id', description: 'Panel ID', type: 'integer' }],
    async run({ service, guild, channel, args, reply }) {
      const id = args.number('id');
      if (id === undefined) {
        const list = service.store.listPanels(guild.id).map((panel) => `\`${panel.id}\` ${panel.name}`);
        await reply(list.join('\n') || 'No panels yet. Use `/setup` to create one.');
        return;
      }
      const panel = service.store.getPanel(id);
      if (panel?.guildId !== guild.id) throw new UserError('No panel with that ID exists on this server.');
      if (channel.isThread()) throw new UserError('Panels must be sent to a regular text channel.');
      await service.sendPanel(panel, channel as TextChannel);
      await reply(`Sent **${panel.name}**.`);
    },
  },
  {
    name: 'id',
    description: 'Show the ID of this server, or of a mention or emoji',
    options: [{ name: 'target', description: 'A channel, role, user or emoji', type: 'string' }],
    private: true,
    async run({ guild, args, reply }) {
      const target = args.text('target');
      if (!target) {
        await reply(`Server ID: \`${guild.id}\``);
        return;
      }
      const id = /(\d{17,20})/.exec(target)?.[1];
      await reply(id ? `ID: \`${id}\`` : 'I could not find an ID in that.');
    },
  },
  {
    name: 'stats',
    description: 'Show ticket statistics',
    private: true,
    async run({ service, guild, reply }) {
      const { panels, claimed } = service.store.stats(guild.id);
      const panelLines = panels.map((panel) => `**${panel.name}**: ${panel.total} total, ${panel.open} open, ${panel.closed} closed`);
      const claimLines = claimed.slice(0, 10).map((row) => `<@${row.userId}>: ${row.count}`);
      await reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Ticket statistics')
            .setColor(0x5865f2)
            .addFields(
              { name: 'Panels', value: panelLines.join('\n').slice(0, 1024) || 'No panels yet' },
              { name: 'Claimed tickets resolved', value: claimLines.join('\n') || 'None yet' },
            ),
        ],
      });
    },
  },
  {
    name: 'new',
    aliases: ['ticket'],
    description: 'Open a new ticket',
    private: true,
    options: [
      { name: 'user', description: 'Open it for this member (support team only)', type: 'user' },
      { name: 'panel', description: 'Panel ID', type: 'integer' },
      { name: 'reason', description: 'Why this ticket is being opened', type: 'string' },
    ],
    async run({ service, guild, channel, member, args, reply, deleteSource }) {
      const channelIds = [channel.id, channel.parentId ?? ''];
      const eligible = service.store
        .listPanels(guild.id)
        .filter(
          (panel) =>
            panel.config.commandStyle.enabled &&
            (panel.config.commandStyle.allChannels || panel.config.commandStyle.channels.some((id) => channelIds.includes(id))),
        );
      const wanted = args.number('panel');
      const panel = wanted === undefined ? eligible[0] : eligible.find((item) => item.id === wanted);
      if (!panel) throw new UserError('Tickets cannot be opened with a command in this channel.');

      const target = args.user('user');
      if (target && target.id !== member.id && !service.isSupport(member, panel)) {
        throw new UserError('Only the support team can open tickets for other members.');
      }
      const owner = target ? await guild.members.fetch(target.id).catch(() => null) : member;
      if (!owner) throw new UserError('That user is not on this server.');

      const ticket = await service.open({ panel, owner, actor: member, reason: args.text('reason') ?? null });
      await reply(`Ticket created: <#${ticket.channelId}>`);
      if (panel.config.commandStyle.deleteCommand) await deleteSource();
    },
  },
  {
    name: 'close',
    description: 'Close this ticket',
    ticketOnly: true,
    options: [{ name: 'reason', description: 'Why it is being closed', type: 'string' }],
    private: true,
    async run(ctx) {
      const { service, ticket, member, args, reply } = inTicket(ctx);
      await reply('Closing this ticket.');
      await service.close(ticket, member, args.text('reason') ?? null);
    },
  },
  {
    name: 'open',
    description: 'Reopen this closed ticket',
    ticketOnly: true,
    private: true,
    async run(ctx) {
      const { service, ticket, member, reply } = inTicket(ctx);
      await service.reopen(ticket, member);
      await reply('Ticket reopened.');
    },
  },
  {
    name: 'delete',
    description: 'Delete this ticket',
    ticketOnly: true,
    options: [{ name: 'reason', description: 'Why it is being deleted', type: 'string' }],
    private: true,
    async run(ctx) {
      const { service, ticket, member, args, reply } = inTicket(ctx);
      await reply('Deleting this ticket.');
      await service.delete(ticket, member, args.text('reason') ?? null);
    },
  },
  {
    name: 'rename',
    description: 'Rename this ticket',
    ticketOnly: true,
    options: [{ name: 'name', description: 'New channel name', type: 'string', required: true }],
    private: true,
    async run(ctx) {
      const { service, ticket, member, args, reply } = inTicket(ctx);
      const name = await service.rename(ticket, member, args.text('name') ?? '');
      await reply(`Renamed to **${name}**.`);
    },
  },
  {
    name: 'transcript',
    description: 'Save a transcript of this ticket',
    ticketOnly: true,
    options: [
      { name: 'channel', description: 'Where to send it', type: 'channel' },
      { name: 'lines', description: 'How many recent messages to include', type: 'integer' },
    ],
    private: true,
    async run(ctx) {
      const { service, ticket, member, args, reply } = inTicket(ctx);
      const lines = args.number('lines');
      if (lines !== undefined && lines < 1) throw new UserError('Choose at least 1 message.');
      const target = await service.saveTranscript(ticket, member, { channelId: args.channel('channel')?.id, lines });
      await reply(`Transcript saved to <#${target}>.`);
    },
  },
  {
    name: 'add',
    description: 'Give a member or role access to this ticket',
    ticketOnly: true,
    options: [{ name: 'target', description: 'Member or role', type: 'mentionable', required: true }],
    async run(ctx) {
      const { service, ticket, member, args, reply } = inTicket(ctx);
      const target = args.mentionable('target');
      if (!target) throw new UserError('I could not find that member or role.');
      await service.addAccess(ticket, member, target);
      await reply(`Added ${target} to this ticket.`);
    },
  },
  {
    name: 'remove',
    description: 'Remove a member or role from this ticket',
    ticketOnly: true,
    options: [{ name: 'target', description: 'Member or role', type: 'mentionable', required: true }],
    async run(ctx) {
      const { service, ticket, member, args, reply } = inTicket(ctx);
      const target = args.mentionable('target');
      if (!target) throw new UserError('I could not find that member or role.');
      await service.removeAccess(ticket, member, target);
      await reply(`Removed ${target} from this ticket.`);
    },
  },
  {
    name: 'claim',
    description: 'Claim this ticket',
    ticketOnly: true,
    options: [
      { name: 'user', description: 'Claim it for this support member', type: 'user' },
      { name: 'reason', description: 'Why it is being claimed', type: 'string' },
    ],
    private: true,
    async run(ctx) {
      const { service, ticket, guild, member, args, reply } = inTicket(ctx);
      const target = args.user('user');
      const claimer = target ? await guild.members.fetch(target.id).catch(() => null) : member;
      if (!claimer) throw new UserError('That user is not on this server.');
      await service.claim(ticket, member, claimer, args.text('reason') ?? null);
      await reply('Ticket claimed.');
    },
  },
  {
    name: 'unclaim',
    description: 'Unclaim this ticket',
    ticketOnly: true,
    private: true,
    async run(ctx) {
      const { service, ticket, member, reply } = inTicket(ctx);
      await service.unclaim(ticket, member);
      await reply('Ticket unclaimed.');
    },
  },
  {
    name: 'closerequest',
    aliases: ['ca'],
    description: 'Ask whether this ticket can be closed',
    ticketOnly: true,
    private: true,
    async run(ctx) {
      const { service, ticket, panel, member, reply } = inTicket(ctx);
      await service.sendCloseAsk(ticket, panel, member);
      await reply('Close request sent.');
    },
  },
  {
    name: 'escalate',
    description: 'Move this ticket to another panel',
    ticketOnly: true,
    options: [{ name: 'reason', description: 'Why it is being moved', type: 'string' }],
    private: true,
    async run(ctx) {
      const { service, ticket, panel, member, args, reply } = inTicket(ctx);
      const targets = service.escalationTargets(ticket, panel);
      service.rememberEscalationReason(ticket, args.text('reason') ?? null);
      if (targets.length === 1) {
        await service.escalate(service.store.getTicket(ticket.id)!, member, targets[0]!);
        await reply(`Ticket moved to **${targets[0]!.name}**.`);
        return;
      }
      await reply({ content: 'Where should this ticket go?', components: service.escalationMenu(targets) });
    },
  },
  {
    name: 'automation',
    description: 'Start, stop or check this ticket’s automations',
    ticketOnly: true,
    options: [{ name: 'action', description: 'What to do', type: 'string', choices: ['start', 'stop'] }],
    private: true,
    async run(ctx) {
      const { service, ticket, panel, args, reply } = inTicket(ctx);
      const action = args.text('action');
      if (action === 'start') {
        if (ticket.state !== 'open') throw new UserError('Reopen this ticket first.');
        service.automation.startManually(ticket, panel);
        await reply('Automations started.');
      } else if (action === 'stop') {
        service.automation.stopManually(ticket);
        await reply('Automations stopped.');
      } else {
        await reply(`${service.automation.activeChecks(ticket)} message check(s) running on this ticket.`);
      }
    },
  },
];

const lookup = new Map<string, CommandDef>();
for (const command of commands) {
  lookup.set(command.name, command);
  for (const alias of command.aliases ?? []) lookup.set(alias, command);
}

export const findCommand = (name: string): CommandDef | undefined => lookup.get(name.toLowerCase());

export function slashDefinitions() {
  return commands.map((command) => {
    const builder = new SlashCommandBuilder().setName(command.name).setDescription(command.description).setContexts(InteractionContextType.Guild);
    for (const option of command.options ?? []) {
      const apply = <T extends { setName(n: string): T; setDescription(d: string): T; setRequired(r: boolean): T }>(input: T) =>
        input.setName(option.name).setDescription(option.description).setRequired(Boolean(option.required));
      if (option.type === 'string') {
        builder.addStringOption((input) => {
          apply(input);
          if (option.choices) input.addChoices(...option.choices.map((choice) => ({ name: choice, value: choice })));
          return input;
        });
      } else if (option.type === 'user') builder.addUserOption(apply);
      else if (option.type === 'role') builder.addRoleOption(apply);
      else if (option.type === 'mentionable') builder.addMentionableOption(apply);
      else if (option.type === 'channel') builder.addChannelOption(apply);
      else builder.addIntegerOption(apply);
    }
    return builder.toJSON();
  });
}
