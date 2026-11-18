import { ChannelType, PermissionFlagsBits } from 'discord.js';

/** A small in-memory stand-in for the parts of Discord the bot talks to. */
let nextId = 200000000000000000n;
export const snowflake = () => String((nextId += 1n));

class Collection<V extends { id?: string }> extends Map<string, V> {
  filter(fn: (value: V) => boolean) {
    return new Collection<V>([...this].filter(([, value]) => fn(value)));
  }
  find(fn: (value: V) => boolean) {
    return [...this.values()].find(fn);
  }
  last() {
    return [...this.values()].at(-1);
  }
}

export function fakeUser(id: string, username: string) {
  const dms: unknown[] = [];
  return {
    id,
    username,
    displayName: username,
    discriminator: '0',
    bot: false,
    dms,
    send: async (payload: unknown) => {
      dms.push(payload);
      return {};
    },
    displayAvatarURL: () => `https://cdn.discordapp.com/embed/avatars/0.png`,
    toString: () => `<@${id}>`,
  };
}

export function fakeMember(guild: ReturnType<typeof fakeGuild>, id: string, name: string, options: { roles?: string[]; admin?: boolean; flags?: bigint } = {}) {
  const user = fakeUser(id, name);
  const roleSet = new Set(options.roles ?? []);
  const cache = new Map([...roleSet].map((role) => [role, { id: role }]));
  const member = {
    id,
    user,
    guild,
    displayName: name,
    roles: {
      cache,
      add: async (ids: string[]) => ids.forEach((role) => cache.set(role, { id: role })),
      remove: async (ids: string[]) => ids.forEach((role) => cache.delete(role)),
    },
    permissions: {
      has: (flag: bigint) => Boolean(options.admin) || (options.flags ?? 0n) === -1n || flag !== PermissionFlagsBits.Administrator,
    },
    send: user.send,
    displayAvatarURL: user.displayAvatarURL,
    toString: () => `<@${id}>`,
  };
  guild.memberMap.set(id, member);
  return member;
}

export function fakeChannel(guild: ReturnType<typeof fakeGuild>, name: string, type: ChannelType, parentId: string | null = null) {
  const channel = {
    id: snowflake(),
    name,
    type,
    parentId,
    guild,
    sent: [] as any[],
    edits: [] as any[],
    overwrites: [] as any[],
    deleted: false,
    threadsMade: [] as any[],
    isThread: () => false,
    isTextBased: () => type === ChannelType.GuildText,
    send: async (payload: any) => {
      for (const row of payload.components ?? []) row.toJSON();
      if (payload.content === '' && !(payload.embeds?.length || payload.files?.length)) throw new Error('empty message');
      const message = {
        id: snowflake(),
        ...payload,
        pinned: false,
        pin: async () => { message.pinned = true; },
        delete: async () => undefined,
      };
      channel.sent.push(message);
      return message;
    },
    edit: async (edit: any) => {
      channel.edits.push(edit);
      if (edit.name) channel.name = edit.name;
      if (edit.parent) channel.parentId = edit.parent;
      if (edit.permissionOverwrites) channel.overwrites = edit.permissionOverwrites;
      return channel;
    },
    setName: async (value: string) => { channel.name = value; return channel; },
    delete: async () => { channel.deleted = true; guild.channelMap.delete(channel.id); return channel; },
    messages: {
      fetch: async () => new Collection<any>(),
      delete: async (id: string) => { channel.sent = channel.sent.filter((item) => item.id !== id); },
    },
    threads: {
      create: async (options: any) => {
        const thread = fakeChannel(guild, options.name, ChannelType.PrivateThread, channel.id) as any;
        thread.isThread = () => true;
        thread.members = { add: async () => undefined, remove: async () => undefined };
        thread.setLocked = async (value: boolean) => { thread.locked = value; };
        channel.threadsMade.push(thread);
        return thread;
      },
    },
  };
  guild.channelMap.set(channel.id, channel);
  return channel;
}

export function fakeGuild(id = '100000000000000001', ownerId = '100000000000000009') {
  const channelMap = new Collection<any>();
  const memberMap = new Map<string, any>();
  const roleCache = new Collection<any>([[id, { id, name: '@everyone', position: 0, managed: false }]]);
  const guild: any = {
    id,
    name: 'Test server',
    ownerId,
    channelMap,
    memberMap,
    iconURL: () => null,
    bannerURL: () => null,
    roles: {
      cache: roleCache,
      fetch: async () => roleCache,
    },
    members: {
      me: undefined as any,
      fetchMe: async () => guild.members.me,
      fetch: async (userId: string) => {
        const member = memberMap.get(userId);
        if (!member) throw Object.assign(new Error('Unknown member'), { code: 10007 });
        return member;
      },
    },
    channels: {
      cache: channelMap,
      fetch: async (channelId?: string) => {
        if (!channelId) return channelMap;
        const channel = channelMap.get(channelId);
        if (!channel) throw Object.assign(new Error('Unknown channel'), { code: 10003 });
        return channel;
      },
      create: async (options: any) => {
        const channel = fakeChannel(guild, options.name, options.type, options.parent ?? null);
        channel.overwrites = options.permissionOverwrites;
        return channel;
      },
    },
  };
  return guild as ReturnType<typeof Object> & {
    id: string;
    channelMap: Collection<any>;
    memberMap: Map<string, any>;
    roles: any;
    members: any;
    channels: any;
    ownerId: string;
    name: string;
  };
}

export function addRole(guild: ReturnType<typeof fakeGuild>, name: string) {
  const id = snowflake();
  guild.roles.cache.set(id, { id, name, position: guild.roles.cache.size, managed: false });
  return id;
}

export function fakeClient(guild: ReturnType<typeof fakeGuild>) {
  const botId = '100000000000000002';
  const me = fakeMember(guild, botId, 'Toxtickety', { admin: true });
  guild.members.me = me;
  return {
    user: { id: botId, tag: 'Toxtickety#0000' },
    application: { id: botId },
    ws: { ping: 12 },
    guilds: { cache: new Map([[guild.id, guild]]) },
    users: {
      cache: new Map(),
      fetch: async (id: string) => {
        const member = guild.memberMap.get(id);
        if (!member) throw new Error('Unknown user');
        return member.user;
      },
    },
  } as any;
}
