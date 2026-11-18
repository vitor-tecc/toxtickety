import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Every customizable setting lives here. The dashboard builds its forms directly from these
 * schemas, so adding a field below makes it editable without touching any frontend code.
 *
 * `.prefault()` is used rather than `.default()` so nested objects still get their inner defaults.
 */

const snowflake = z.string().regex(/^\d{17,20}$/, 'Must be a Discord ID');
const optionalId = (title: string, picker: 'channel' | 'category' | 'role', description?: string) =>
  z
    .string()
    .regex(/^(\d{17,20})?$/, 'Must be a Discord ID')
    .prefault('')
    .meta({ title, picker, description });
const idList = (title: string, picker: 'channel' | 'category' | 'role', description?: string) =>
  z.array(snowflake).max(100).prefault([]).meta({ title, picker, description });
const text = (title: string, max: number, fallback = '', description?: string) =>
  z.string().max(max).prefault(fallback).meta({ title, description });
const longText = (title: string, max: number, fallback = '', description?: string) =>
  z.string().max(max).prefault(fallback).meta({ title, description, multiline: true });
const toggle = (title: string, fallback = false, description?: string) =>
  z.boolean().prefault(fallback).meta({ title, description });
const limit = (title: string, fallback = 0, description = '0 means no limit') =>
  z.number().int().min(0).max(100_000).prefault(fallback).meta({ title, description });

// Messages -------------------------------------------------------------------------------------

export const embedSchema = z.object({
  title: text('Title', 256),
  description: longText('Description', 4096),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color such as #5865F2')
    .prefault('#5865F2')
    .meta({ title: 'Color', format: 'color' }),
  url: text('Title link', 500),
  authorName: text('Author name', 256),
  authorIcon: text('Author icon URL', 500),
  thumbnail: text('Thumbnail URL', 500),
  image: text('Image URL', 500),
  footer: text('Footer', 2048),
  footerIcon: text('Footer icon URL', 500),
  timestamp: toggle('Show timestamp'),
  fields: z
    .array(
      z.object({
        name: text('Name', 256),
        value: longText('Value', 1024),
        inline: toggle('Inline'),
      }),
    )
    .max(25)
    .prefault([])
    .meta({ title: 'Fields', itemLabel: 'Field' }),
});

export const messageSchema = z.object({
  content: longText('Message text', 2000),
  embeds: z.array(embedSchema).max(10).prefault([]).meta({ title: 'Embeds', itemLabel: 'Embed' }),
});

export type MessageTemplate = z.output<typeof messageSchema>;
export type EmbedTemplate = z.output<typeof embedSchema>;

const message = (title: string, description: string, content = '', help?: string) =>
  messageSchema
    .prefault({ content, embeds: description ? [{ description }] : [] })
    .meta({ title, description: help, kind: 'message' });

// Buttons --------------------------------------------------------------------------------------

export const buttonStyles = ['primary', 'secondary', 'success', 'danger'] as const;

const button = (
  title: string,
  label: string,
  emoji: string,
  style: (typeof buttonStyles)[number],
  supportOnly = false,
) =>
  z
    .object({
      show: toggle('Show this button', true),
      label: text('Text', 80, label),
      emoji: text('Emoji', 100, emoji, 'A unicode emoji, or a custom one such as <:name:id>'),
      style: z.enum(buttonStyles).prefault(style).meta({ title: 'Color' }),
      supportOnly: toggle('Support team only', supportOnly),
      allowedRoles: idList('Allowed roles', 'role', 'These roles can always use the button'),
      disabledRoles: idList('Disabled roles', 'role', 'Allowed roles override this list'),
    })
    .prefault({})
    .meta({ title });

export type ButtonConfig = z.output<ReturnType<typeof button>>;

// Permissions ----------------------------------------------------------------------------------

export const channelPermissions = [
  'ViewChannel',
  'SendMessages',
  'ReadMessageHistory',
  'AttachFiles',
  'EmbedLinks',
  'AddReactions',
  'UseExternalEmojis',
  'UseExternalStickers',
  'MentionEveryone',
  'ManageMessages',
  'ManageThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
  'SendMessagesInThreads',
  'SendTTSMessages',
  'SendVoiceMessages',
  'SendPolls',
  'UseApplicationCommands',
] as const;
export type ChannelPermission = (typeof channelPermissions)[number];

const permissionSet = (title: string, allow: ChannelPermission[], deny: ChannelPermission[]) =>
  z
    .object({
      allow: z.array(z.enum(channelPermissions)).prefault(allow).meta({ title: 'Allow' }),
      deny: z.array(z.enum(channelPermissions)).prefault(deny).meta({ title: 'Deny' }),
    })
    .prefault({})
    .meta({ title, kind: 'permissions' });

export type PermissionSet = { allow: ChannelPermission[]; deny: ChannelPermission[] };

const chat: ChannelPermission[] = [
  'ViewChannel',
  'SendMessages',
  'ReadMessageHistory',
  'AttachFiles',
  'EmbedLinks',
  'AddReactions',
  'UseExternalEmojis',
];
const staff: ChannelPermission[] = [...chat, 'ManageMessages'];
const readOnly: ChannelPermission[] = ['ViewChannel', 'ReadMessageHistory'];

// Automations ----------------------------------------------------------------------------------

const automationAction = z
  .object({
    type: z.enum(['close', 'delete', 'customCommand']).prefault('close').meta({ title: 'Action' }),
    commandName: z.string().max(100).prefault('').meta({ title: 'Custom command name', when: { type: 'customCommand' } }),
  })
  .prefault({})
  .meta({ title: 'Run this action' });

export const automationSchema = z.object({
  id: z.string().default(() => randomUUID()).meta({ hidden: true }),
  name: text('Name', 80, 'Automation'),
  enabled: toggle('Enabled', true),
  kind: z.enum(['messageCheck', 'trigger']).prefault('messageCheck').meta({ title: 'Type' }),
  // Message check
  checkType: z
    .enum(['notFound', 'found'])
    .prefault('notFound')
    .meta({ title: 'Check', when: { kind: 'messageCheck' } }),
  from: z.enum(['anyone', 'owner', 'support']).prefault('owner').meta({ title: 'Message from', when: { kind: 'messageCheck' } }),
  windowSeconds: z
    .number()
    .int()
    .min(300)
    .max(604_800)
    .prefault(86_400)
    .meta({ title: 'Time window (seconds)', description: 'Minimum 300 seconds (5 minutes)', when: { kind: 'messageCheck' } }),
  repeat: z.enum(['once', 'untilStopped']).prefault('once').meta({ title: 'It should check', when: { kind: 'messageCheck' } }),
  onMessageInWindow: z
    .enum(['restart', 'continue'])
    .prefault('restart')
    .meta({ title: 'If a message arrives in the window', when: { kind: 'messageCheck', checkType: 'notFound' } }),
  afterAction: z.enum(['stop', 'keepChecking']).prefault('stop').meta({ title: 'After the action runs', when: { kind: 'messageCheck' } }),
  // Event trigger
  event: z
    .enum(['created', 'closed', 'reopened', 'ownerLeft', 'closeAsk'])
    .prefault('closed')
    .meta({ title: 'Trigger event', when: { kind: 'trigger' } }),
  delaySeconds: z
    .number()
    .int()
    .min(0)
    .max(2_592_000)
    .prefault(0)
    .meta({ title: 'Delay (seconds)', description: 'Wait this long after the event', when: { kind: 'trigger' } }),
  action: automationAction,
});
export type Automation = z.output<typeof automationSchema>;

// Schedule -------------------------------------------------------------------------------------

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Use 24-hour HH:MM');
const dayWindows = (title: string) =>
  z
    .array(
      z.object({
        start: clockTime.prefault('09:00').meta({ title: 'From' }),
        end: clockTime.prefault('17:00').meta({ title: 'To' }),
      }),
    )
    .max(10)
    .prefault([])
    .meta({ title, itemLabel: 'Time frame' });

export const scheduleSchema = z.object({
  enabled: toggle('Enable schedule'),
  timezone: z
    .string()
    .refine(isTimeZone, 'Unknown timezone')
    .prefault('UTC')
    .meta({ title: 'Timezone', description: 'IANA name, for example America/Sao_Paulo' }),
  bypassRoles: idList('Roles that bypass the schedule', 'role'),
  replaceTicketMessage: toggle(
    'Still open the ticket, using the schedule message',
    false,
    'When off, members are told to come back later and no ticket is created',
  ),
  message: message('Schedule notification message', 'We are currently closed. Please try again during opening hours.'),
  monday: dayWindows('Monday'),
  tuesday: dayWindows('Tuesday'),
  wednesday: dayWindows('Wednesday'),
  thursday: dayWindows('Thursday'),
  friday: dayWindows('Friday'),
  saturday: dayWindows('Saturday'),
  sunday: dayWindows('Sunday'),
});
export type Schedule = z.output<typeof scheduleSchema>;

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Panel ----------------------------------------------------------------------------------------

const roleChange = (title: string) =>
  z
    .object({
      add: idList('Roles to add', 'role'),
      remove: idList('Roles to remove', 'role'),
    })
    .prefault({})
    .meta({ title });

const transcriptTrigger = (title: string) =>
  z.enum(['never', 'close', 'delete', 'both']).prefault('never').meta({ title });

export const panelSchema = z.object({
  general: z
    .object({
      supportRoles: idList('Support team roles', 'role', 'Can see tickets and use support-only actions'),
      additionalRoles: idList('Additional roles', 'role', 'A second group, for example read-only observers'),
      padding: z
        .number()
        .int()
        .min(0)
        .max(20)
        .prefault(4)
        .meta({ title: 'Ticket number padding', description: '4 turns ticket 7 into 0007' }),
      twoStepClose: toggle('Ask for confirmation before closing', true),
      twoStepTicket: toggle('Keep closed tickets', true, 'When off, closing a ticket deletes it right away'),
      autoPin: toggle('Pin the ticket message'),
    })
    .prefault({})
    .meta({ title: 'General' }),

  category: z
    .object({
      opened: optionalId('Category for open tickets', 'category'),
      closed: optionalId('Category for closed tickets', 'category', 'Leave empty to keep them where they are'),
      overflow: idList('Overflow categories', 'category', 'Used when a category reaches the 50 channel limit'),
    })
    .prefault({})
    .meta({ title: 'Categories' }),

  ticket: z
    .object({
      openedName: text('Open ticket channel name', 100, 'ticket-{count}', 'Example: complaint-{count}'),
      closedName: text('Closed ticket channel name', 100, 'closed-{count}'),
      message: message(
        'Ticket message',
        'Support will be with you shortly.\nTo close this ticket, press the button below.',
        '{ticket.user} Welcome',
      ),
      closeAskMessage: message('Close confirmation message', 'Are you sure you would like to close this ticket?'),
      openedRoles: roleChange('Ticket owner roles when opened'),
      closedRoles: roleChange('Ticket owner roles when closed or deleted'),
      privateThread: z
        .object({
          enabled: toggle('Attach a private staff thread to each ticket'),
          name: text('Thread name', 100, 'staff-{count}'),
          autoAddTeam: toggle('Add the support team automatically', true),
          nonModsCanInvite: toggle('Members can invite others to the thread'),
        })
        .prefault({})
        .meta({ title: 'Private staff thread' }),
    })
    .prefault({})
    .meta({ title: 'Ticket' }),

  moderator: z
    .object({
      closedMessage: message('Closed message', 'Ticket closed by {author}.'),
      openedMessage: message('Reopened message', 'Ticket reopened by {author}.'),
      moderatorMessage: message('Moderator message', '```Support team ticket controls```'),
      deleteMessage: message('Delete message', 'This ticket will be deleted in a few seconds.'),
    })
    .prefault({})
    .meta({ title: 'Moderator' }),

  permissions: z
    .object({
      opened: z
        .object({
          support: permissionSet('Support team', staff, []),
          user: permissionSet('Ticket owner and added users', chat, []),
          additional: permissionSet('Additional roles', readOnly, ['SendMessages']),
          everyone: permissionSet('@everyone', [], ['ViewChannel']),
        })
        .prefault({})
        .meta({ title: 'While the ticket is open' }),
      closed: z
        .object({
          support: permissionSet('Support team', staff, []),
          user: permissionSet('Ticket owner and added users', [], ['ViewChannel', 'SendMessages']),
          additional: permissionSet('Additional roles', readOnly, ['SendMessages']),
          everyone: permissionSet('@everyone', [], ['ViewChannel']),
        })
        .prefault({})
        .meta({ title: 'While the ticket is closed' }),
    })
    .prefault({})
    .meta({ title: 'Permissions' }),

  buttons: z
    .object({
      create: button('Create ticket', 'Create ticket', '📩', 'primary'),
      close: button('Close ticket', 'Close', '🔒', 'secondary'),
      claim: button('Claim ticket', 'Claim', '🙋', 'success', true),
      confirmClose: button('Confirm close', 'Close', '', 'danger'),
      cancelClose: button('Cancel close', 'Cancel', '', 'secondary'),
      reopen: button('Reopen ticket', 'Open', '🔓', 'secondary', true),
      delete: button('Delete ticket', 'Delete', '⛔', 'secondary', true),
      transcript: button('Transcript', 'Transcript', '📑', 'secondary', true),
    })
    .prefault({})
    .meta({ title: 'Buttons' }),

  escalate: z
    .object({
      panels: z
        .array(z.number().int().positive())
        .max(25)
        .prefault([])
        .meta({ title: 'Panels tickets can move to', picker: 'panel' }),
      updateCategory: toggle('Move to the target panel category', true),
      updateName: toggle('Rename using the target panel', true),
      updatePermissions: toggle('Apply the target panel permissions', true),
      autoUnclaim: toggle('Unclaim the ticket', true),
      sendTicketMessage: toggle('Send the target panel ticket message'),
      customMessage: message(
        'Escalation message',
        'Ticket moved from **{escalate.from}** to **{escalate.to}** by {escalate.user}.\nReason: {escalate.reason}',
      ),
    })
    .prefault({})
    .meta({ title: 'Escalation' }),

  transcript: z
    .object({
      channel: optionalId('Transcript channel', 'channel'),
      message: message('Transcript message', 'Transcript for **{channel.name}**, opened by {ticket.user}.'),
      maxMessages: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .prefault(1000)
        .meta({ title: 'Messages to include' }),
      dmOwner: transcriptTrigger('Send to the ticket owner by DM'),
      autoSave: transcriptTrigger('Save to the transcript channel automatically'),
    })
    .prefault({})
    .meta({ title: 'Transcripts' }),

  logging: z
    .object({
      channel: optionalId('Logging channel', 'channel'),
      created: toggle('Ticket created', true),
      closed: toggle('Ticket closed', true),
      reopened: toggle('Ticket reopened', true),
      renamed: toggle('Ticket renamed', true),
      deleted: toggle('Ticket deleted', true),
      transcript: toggle('Transcript saved', true),
      claimed: toggle('Ticket claimed or unclaimed', true),
      escalated: toggle('Ticket escalated', true),
    })
    .prefault({})
    .meta({ title: 'Logging' }),

  automation: z
    .object({
      missingUser: z
        .enum(['nothing', 'close', 'delete'])
        .prefault('nothing')
        .meta({ title: 'When the ticket owner leaves the server' }),
      dmOnCreate: toggle('DM the owner when a ticket is created'),
      createdDm: message('Created DM', 'Your ticket {ticket} in **{server.name}** has been created.'),
      dmOnClose: toggle('DM the owner when a ticket is closed'),
      closedDm: message('Closed DM', 'Your ticket **{channel.name}** in **{server.name}** has been closed.'),
      rules: z
        .array(automationSchema)
        .max(10)
        .prefault([])
        .meta({ title: 'Automations', itemLabel: 'Automation' }),
    })
    .prefault({})
    .meta({ title: 'Automation' }),

  limits: z
    .object({
      openPerUser: limit('Open tickets per member', 1),
      openTotal: limit('Open tickets in this panel'),
      openBypassRoles: idList('Roles that bypass open limits', 'role'),
      closedPerUser: limit('Closed tickets per member'),
      closedTotal: limit('Closed tickets in this panel'),
      closedBypassRoles: idList('Roles that bypass closed limits', 'role'),
      schedule: scheduleSchema.prefault({}).meta({ title: 'Opening hours' }),
    })
    .prefault({})
    .meta({ title: 'Limits' }),

  claiming: z
    .object({
      enabled: toggle('Enable claiming'),
      onlyClaimerCanUnclaim: toggle('Only the claimer can unclaim'),
      restrictActions: toggle('Only the claimer and owner can reopen, delete or save transcripts'),
      overwriteClaim: toggle('Claiming a claimed ticket takes it over instead of unclaiming'),
      allowOwnerClaim: toggle('Let the ticket owner claim their own ticket'),
      nameEnabled: toggle('Rename the ticket when claimed'),
      name: text('Claimed channel name', 100, 'claimed-{count}'),
      categories: idList('Claimed ticket categories', 'category', 'The first with free space is used'),
      claimedRoles: roleChange('Ticket owner roles when claimed'),
      unclaimedRoles: roleChange('Ticket owner roles when unclaimed'),
      changeSupportPermissions: toggle('Limit other support members once claimed'),
      claimedSupportPermissions: permissionSet('Other support members while claimed', readOnly, ['SendMessages']),
      claimedMessage: message('Claimed message', 'Your ticket will be handled by {claim.user}.'),
      unclaimedMessage: message('Unclaimed message', 'This ticket is no longer claimed.'),
    })
    .prefault({})
    .meta({ title: 'Claiming' }),

  form: z
    .object({
      enabled: toggle('Ask questions before creating the ticket'),
      autoDisplay: toggle('Show the answers in the ticket', true),
      title: text('Form title', 45, 'Open a ticket'),
      questions: z
        .array(
          z.object({
            title: z.string().min(1).max(45).prefault('Question').meta({ title: 'Question' }),
            placeholder: text('Placeholder', 100),
            required: toggle('Required', true),
            multiline: toggle('Multi-line answer'),
            minLength: z.number().int().min(0).max(4000).prefault(0).meta({ title: 'Minimum characters' }),
            maxLength: z.number().int().min(1).max(4000).prefault(4000).meta({ title: 'Maximum characters' }),
          }),
        )
        .max(5)
        .prefault([])
        .meta({ title: 'Questions', itemLabel: 'Question' }),
    })
    .prefault({})
    .meta({ title: 'Form' }),

  panel: z
    .object({
      message: message('Panel message', 'To create a ticket, use the button below.'),
      attachedPanels: z
        .array(z.number().int().positive())
        .max(24)
        .prefault([])
        .meta({ title: 'Attached panels', picker: 'panel', description: 'Show their buttons on this panel too' }),
      buttonsPerRow: z.number().int().min(1).max(5).prefault(5).meta({ title: 'Buttons per row' }),
      dropdown: z
        .object({
          enabled: toggle('Use a dropdown instead of buttons'),
          placeholder: text('Placeholder', 150, 'Select a ticket type'),
          options: z
            .array(
              z.object({
                display: z.string().min(1).max(100).prefault('Option').meta({ title: 'Display text' }),
                panelId: z.number().int().positive().prefault(1).meta({ title: 'Panel', picker: 'panel' }),
                emoji: text('Emoji', 100),
                description: text('Description', 100),
              }),
            )
            .max(25)
            .prefault([])
            .meta({ title: 'Options', itemLabel: 'Option' }),
        })
        .prefault({})
        .meta({ title: 'Dropdown' }),
    })
    .prefault({})
    .meta({ title: 'Panel' }),

  commandStyle: z
    .object({
      enabled: toggle('Allow creating tickets with /new, $new and $ticket'),
      deleteCommand: toggle('Delete the command message afterwards'),
      allChannels: toggle('Watch every channel'),
      channels: idList('Channels to watch', 'channel'),
    })
    .prefault({})
    .meta({ title: 'Command style' }),

  threadStyle: z
    .object({
      enabled: toggle('Create tickets as private threads'),
      parentChannel: optionalId('Channel to create threads under', 'channel'),
      nonModsCanInvite: toggle('Members can invite others to the ticket'),
      autoAddTeam: toggle('Add the support team automatically', true),
    })
    .prefault({})
    .meta({ title: 'Thread style' }),
});

export type PanelConfig = z.output<typeof panelSchema>;

// Server ---------------------------------------------------------------------------------------

export const commandNames = [
  'help',
  'debug',
  'permissionlevel',
  'ping',
  'panel',
  'id',
  'stats',
  'new',
  'close',
  'open',
  'delete',
  'rename',
  'transcript',
  'add',
  'remove',
  'claim',
  'unclaim',
  'closerequest',
  'escalate',
  'automation',
] as const;
export type CommandName = (typeof commandNames)[number];

const supportOnlyByDefault = new Set<CommandName>([
  'open',
  'delete',
  'rename',
  'transcript',
  'add',
  'remove',
  'claim',
  'unclaim',
  'closerequest',
  'escalate',
  'automation',
  'stats',
]);

const commandRule = (name: CommandName) =>
  z
    .object({
      enabled: toggle('Enabled', true),
      supportOnly: toggle('Support team only', supportOnlyByDefault.has(name)),
      allowedChannels: idList('Allowed channels', 'channel', 'Overrides disabled channels'),
      disabledChannels: idList('Disabled channels', 'channel'),
      allowedRoles: idList('Allowed roles', 'role', 'Overrides disabled roles'),
      disabledRoles: idList('Disabled roles', 'role'),
    })
    .prefault({})
    .meta({ title: name });

export type CommandRule = z.output<ReturnType<typeof commandRule>>;

const commandsShape = Object.fromEntries(commandNames.map((name) => [name, commandRule(name)])) as Record<
  CommandName,
  ReturnType<typeof commandRule>
>;

export const customCommandSchema = z
  .object({
    id: z.string().default(() => randomUUID()).meta({ hidden: true }),
    name: z.string().min(1).max(100).prefault('command').meta({ title: 'Command name' }),
    group: text('Group', 100),
    notes: text('Notes', 500, '', 'Only visible on the dashboard'),
    triggerType: z.enum(['strict', 'wildcard', 'regex']).prefault('strict').meta({ title: 'Trigger type' }),
    trigger: z.string().min(1).max(500).prefault('!hello').meta({ title: 'Trigger' }),
    caseSensitive: toggle('Case sensitive'),
    deleteTrigger: toggle('Delete the triggering message'),
    dmTicketOwner: toggle('DM the ticket owner instead'),
    dmResponse: toggle('DM the response to whoever used it'),
    adminOnly: toggle('Admins only'),
    argumentCount: z
      .number()
      .int()
      .min(0)
      .max(5)
      .prefault(0)
      .meta({ title: 'Arguments', description: 'Use them as {argument.1} to {argument.5}' }),
    argumentSeparator: z.string().min(1).max(10).prefault(',').meta({ title: 'Argument separator' }),
    response: message('Response', 'Hello {author}!'),
  })
  .superRefine((command, ctx) => {
    if (command.triggerType !== 'regex') return;
    try {
      new RegExp(command.trigger);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['trigger'], message: 'Invalid regular expression' });
    }
  });
export type CustomCommand = z.output<typeof customCommandSchema>;

export const guildSchema = z.object({
  general: z
    .object({
      prefix: z.string().min(1).max(5).prefault('$').meta({ title: 'Command prefix' }),
      dashboardRoles: idList('Dashboard roles', 'role', 'Can edit every setting here'),
      blacklistRoles: idList('Blacklisted roles', 'role', 'Cannot use commands or buttons'),
      globalTicketLimit: limit('Open tickets per member across all panels'),
      authorizedBots: z
        .array(snowflake)
        .max(50)
        .prefault([])
        .meta({ title: 'Authorized bots', description: 'Bot IDs allowed to trigger commands' }),
    })
    .prefault({})
    .meta({ title: 'General' }),
  commands: z.object(commandsShape).prefault({}).meta({ title: 'Command permissions' }),
  customCommands: z
    .array(customCommandSchema)
    .max(200)
    .prefault([])
    .meta({ title: 'Custom commands', itemLabel: 'Command' }),
});

export type GuildConfig = z.output<typeof guildSchema>;

export const parsePanel = (value: unknown = {}): PanelConfig => panelSchema.parse(value);
export const parseGuild = (value: unknown = {}): GuildConfig => guildSchema.parse(value);

export const backupSchema = z.object({
  version: z.literal(1),
  guild: guildSchema,
  panels: z
    .array(z.object({ name: z.string().min(1).max(80), config: panelSchema }))
    .max(200),
});
