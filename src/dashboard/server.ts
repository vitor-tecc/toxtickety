import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType, type Guild, type GuildMember, type TextChannel } from 'discord.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  backupSchema,
  guildSchema,
  panelSchema,
  parsePanel,
} from '../config/schema.js';
import { UserError } from '../core/errors.js';
import type { Panel, Session } from '../db/store.js';
import type { Bot } from '../discord/bot.js';
import type { Env } from '../env.js';

const SESSION_COOKIE = 'toxtickety_session';
const STATE_COOKIE = 'toxtickety_oauth';
const SESSION_MS = 7 * 86_400_000;
const INSECURE_SESSION_MS = 12 * 3_600_000;
const DISCORD_API = 'https://discord.com/api/v10';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

interface Scope {
  session: Session;
  guild: Guild;
  member: GuildMember;
}

type ScopedResponse = Response<unknown, { session: Session; scope: Scope }>;

export interface DashboardOptions {
  publicUrl: string;
  clientSecret: string;
}

const panelBody = z.object({
  name: z.string().trim().min(1).max(80),
  count: z.number().int().min(0).max(1_000_000_000).optional(),
  config: panelSchema,
});

const issues = (error: z.ZodError) =>
  error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));

export function createDashboardApp(bot: Bot, options: DashboardOptions) {
  const { client, store, service } = bot;
  const app = express();
  const origin = new URL(options.publicUrl).origin;
  const secure = options.publicUrl.startsWith('https://');
  // Without HTTPS a sign-in could be intercepted, so sessions on plain HTTP end much sooner.
  const sessionMs = secure ? SESSION_MS : INSECURE_SESSION_MS;
  const cookie = (maxAge: number, sameSite: 'lax' = 'lax') => ({
    httpOnly: true,
    sameSite,
    secure,
    path: '/',
    maxAge,
  });

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https://cdn.discordapp.com data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Sign in --------------------------------------------------------------------------------------

  const redirectUri = `${options.publicUrl}/auth/callback`;

  app.get('/auth/login', (_req, res) => {
    const state = randomBytes(24).toString('hex');
    res.cookie(STATE_COOKIE, state, cookie(600_000));
    const query = new URLSearchParams({
      client_id: client.application?.id ?? client.user?.id ?? '',
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'identify',
      state,
      prompt: 'none',
    });
    res.redirect(`https://discord.com/oauth2/authorize?${query}`);
  });

  app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    const expected = readCookie(req, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (typeof code !== 'string' || typeof state !== 'string' || !expected || !sameText(state, expected)) {
      res.redirect('/?error=login');
      return;
    }
    try {
      const token = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: client.application?.id ?? client.user?.id ?? '',
          client_secret: options.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });
      if (!token.ok) throw new Error(`token exchange returned ${token.status}`);
      const { access_token: accessToken } = (await token.json()) as { access_token: string };
      const profile = await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!profile.ok) throw new Error(`profile request returned ${profile.status}`);
      const user = (await profile.json()) as { id: string; username: string; avatar: string | null };

      const sessionToken = randomBytes(32).toString('hex');
      store.createSession(hash(sessionToken), {
        userId: user.id,
        username: user.username,
        avatar: user.avatar,
        expiresAt: Date.now() + sessionMs,
      });
      res.cookie(SESSION_COOKIE, sessionToken, cookie(sessionMs));
      res.redirect('/');
    } catch (error) {
      console.error('[dashboard] login failed:', error);
      res.redirect('/?error=login');
    }
  });

  // API guards -----------------------------------------------------------------------------------

  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));

  /** Browsers cannot send this header cross-site without permission, which blocks forged requests. */
  api.use((req, res, next) => {
    if (req.method === 'GET') {
      next();
      return;
    }
    const sender = req.headers.origin;
    if (req.headers['x-toxtickety'] !== '1' || (sender !== undefined && sender !== origin)) {
      res.status(403).json({ error: 'This request was blocked.' });
      return;
    }
    next();
  });

  api.use((req, res: ScopedResponse, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    const session = token ? store.getSession(hash(token)) : undefined;
    if (!session) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    res.locals.session = session;
    next();
  });

  /** Access is checked live against Discord on every request, so removed admins lose it at once. */
  const guildAccess = async (req: Request, res: ScopedResponse, next: NextFunction) => {
    const guild = client.guilds.cache.get(String(req.params.guildId));
    const member = guild ? await guild.members.fetch(res.locals.session.userId).catch(() => null) : null;
    if (!guild || !member || !service.isAdmin(member)) {
      res.status(403).json({ error: 'You do not have access to this server.' });
      return;
    }
    res.locals.scope = { session: res.locals.session, guild, member };
    next();
  };

  const findPanel = (req: Request, res: ScopedResponse): Panel | undefined => {
    const panel = store.getPanel(Number(req.params.panelId));
    if (panel?.guildId === res.locals.scope.guild.id) return panel;
    res.status(404).json({ error: 'That panel no longer exists.' });
    return undefined;
  };

  const audit = (res: ScopedResponse, action: string, detail = '') => {
    const { guild, member } = res.locals.scope;
    store.addAudit(guild.id, member.id, member.user.username, action, detail);
  };

  const panelJson = (panel: Panel) => ({ id: panel.id, name: panel.name, count: panel.count, config: panel.config });

  // API routes -----------------------------------------------------------------------------------

  api.get('/me', (_req, res: ScopedResponse) => {
    const { userId, username, avatar } = res.locals.session;
    res.json({ id: userId, username, avatar });
  });

  api.post('/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) store.deleteSession(hash(token));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  api.get('/schema', (_req, res) => {
    res.json({
      panel: z.toJSONSchema(panelSchema, { io: 'input', unrepresentable: 'any' }),
      guild: z.toJSONSchema(guildSchema, { io: 'input', unrepresentable: 'any' }),
    });
  });

  api.get('/guilds', async (_req, res: ScopedResponse) => {
    const result: { id: string; name: string; icon: string | null }[] = [];
    for (const guild of client.guilds.cache.values()) {
      const member = await guild.members.fetch(res.locals.session.userId).catch(() => null);
      if (member && service.isAdmin(member)) {
        result.push({ id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) });
      }
    }
    res.json(result);
  });

  api.get('/guilds/:guildId', guildAccess, async (_req, res: ScopedResponse) => {
    const { guild, member } = res.locals.scope;
    const channels = await guild.channels.fetch();
    const roles = await guild.roles.fetch();
    res.json({
      id: guild.id,
      name: guild.name,
      isOwner: member.id === guild.ownerId,
      config: store.getGuild(guild.id),
      panels: store.listPanels(guild.id).map(panelJson),
      roles: [...roles.values()]
        .filter((role) => role.id !== guild.id && !role.managed)
        .sort((a, b) => b.position - a.position)
        .map((role) => ({ id: role.id, name: role.name })),
      channels: [...channels.values()]
        .filter((channel) => channel?.type === ChannelType.GuildText)
        .map((channel) => ({ id: channel!.id, name: channel!.name })),
      categories: [...channels.values()]
        .filter((channel) => channel?.type === ChannelType.GuildCategory)
        .map((channel) => ({ id: channel!.id, name: channel!.name })),
    });
  });

  api.put('/guilds/:guildId/config', guildAccess, (req, res: ScopedResponse) => {
    const parsed = guildSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Some settings need fixing.', issues: issues(parsed.error) });
      return;
    }
    store.saveGuild(res.locals.scope.guild.id, parsed.data);
    audit(res, 'Updated server settings');
    res.json(parsed.data);
  });

  api.post('/guilds/:guildId/panels', guildAccess, (req, res: ScopedResponse) => {
    const name = z.string().trim().min(1).max(80).safeParse(req.body?.name);
    if (!name.success) {
      res.status(400).json({ error: 'Give the panel a name.' });
      return;
    }
    const panel = store.createPanel(res.locals.scope.guild.id, name.data, parsePanel());
    audit(res, 'Created panel', panel.name);
    res.status(201).json(panelJson(panel));
  });

  api.put('/guilds/:guildId/panels/:panelId', guildAccess, (req, res: ScopedResponse) => {
    const panel = findPanel(req, res);
    if (!panel) return;
    const parsed = panelBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Some settings need fixing.', issues: issues(parsed.error) });
      return;
    }
    store.updatePanel(panel.id, parsed.data.name, parsed.data.config);
    if (parsed.data.count !== undefined) store.setPanelCount(panel.id, parsed.data.count);
    audit(res, 'Updated panel', parsed.data.name);
    res.json(panelJson(store.getPanel(panel.id)!));
  });

  api.post('/guilds/:guildId/panels/:panelId/clone', guildAccess, (req, res: ScopedResponse) => {
    const panel = findPanel(req, res);
    if (!panel) return;
    const copy = store.createPanel(panel.guildId, `${panel.name} copy`.slice(0, 80), panel.config);
    audit(res, 'Copied panel', panel.name);
    res.status(201).json(panelJson(copy));
  });

  api.delete('/guilds/:guildId/panels/:panelId', guildAccess, (req, res: ScopedResponse) => {
    const panel = findPanel(req, res);
    if (!panel) return;
    if (store.countLiveTickets(panel.id) > 0) {
      res.status(409).json({ error: 'Delete this panel’s open and closed tickets first.' });
      return;
    }
    store.deletePanel(panel.id);
    audit(res, 'Deleted panel', panel.name);
    res.json({ ok: true });
  });

  api.post('/guilds/:guildId/panels/:panelId/send', guildAccess, async (req, res: ScopedResponse) => {
    const panel = findPanel(req, res);
    if (!panel) return;
    const channelId = z.string().regex(/^\d{17,20}$/).safeParse(req.body?.channelId);
    const channel = channelId.success
      ? await res.locals.scope.guild.channels.fetch(channelId.data).catch(() => null)
      : null;
    if (channel?.type !== ChannelType.GuildText) {
      res.status(400).json({ error: 'Choose a text channel.' });
      return;
    }
    try {
      await service.sendPanel(panel, channel as TextChannel);
    } catch (error) {
      res.status(400).json({ error: error instanceof UserError ? error.message : 'The panel could not be sent.' });
      return;
    }
    audit(res, 'Sent panel', `${panel.name} to #${channel.name}`);
    res.json({ ok: true });
  });

  api.get('/guilds/:guildId/stats', guildAccess, async (_req, res: ScopedResponse) => {
    const { guild } = res.locals.scope;
    const stats = store.stats(guild.id);
    const claimed = await Promise.all(
      stats.claimed.map(async (row) => {
        const user = await client.users.fetch(row.userId).catch(() => null);
        return { ...row, name: user?.username ?? row.userId };
      }),
    );
    res.json({ ...stats, claimed });
  });

  api.get('/guilds/:guildId/history', guildAccess, (_req, res: ScopedResponse) => {
    res.json(store.listAudit(res.locals.scope.guild.id));
  });

  const ownerOnly = (_req: Request, res: ScopedResponse, next: NextFunction) => {
    const { guild, member } = res.locals.scope;
    if (member.id !== guild.ownerId) {
      res.status(403).json({ error: 'Only the server owner can do this.' });
      return;
    }
    next();
  };

  api.get('/guilds/:guildId/backup', guildAccess, ownerOnly, (_req, res: ScopedResponse) => {
    const { guild } = res.locals.scope;
    res.setHeader('Content-Disposition', `attachment; filename="toxtickety-${guild.id}.json"`);
    res.json({
      version: 1,
      guild: store.getGuild(guild.id),
      panels: store.listPanels(guild.id).map((panel) => ({ name: panel.name, config: panel.config })),
    });
  });

  api.post('/guilds/:guildId/restore', guildAccess, ownerOnly, (req, res: ScopedResponse) => {
    const parsed = backupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'That file is not a valid backup.', issues: issues(parsed.error) });
      return;
    }
    const { guild } = res.locals.scope;
    store.db.transaction(() => {
      store.saveGuild(guild.id, parsed.data.guild);
      for (const panel of parsed.data.panels) store.createPanel(guild.id, panel.name, panel.config);
    })();
    audit(res, 'Restored backup', `${parsed.data.panels.length} panel(s) added`);
    res.json({ ok: true });
  });

  app.use('/api', api);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), 'public')));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number }).status;
    if (status && status < 500) {
      res.status(status).json({ error: 'That request could not be read.' });
      return;
    }
    console.error('[dashboard] request failed:', error);
    res.status(500).json({ error: 'The server could not finish that request.' });
  });

  return app;
}

/** Starts the dashboard when it is configured. The bot runs fine without it. */
export function startDashboard(bot: Bot, env: Env): Server | undefined {
  if (!env.DASHBOARD_URL || !env.DISCORD_CLIENT_SECRET) {
    console.log('[dashboard] disabled: set DASHBOARD_URL and DISCORD_CLIENT_SECRET to enable it');
    return undefined;
  }
  const app = createDashboardApp(bot, { publicUrl: env.DASHBOARD_URL, clientSecret: env.DISCORD_CLIENT_SECRET });
  const { protocol, hostname } = new URL(env.DASHBOARD_URL);
  if (protocol === 'http:' && hostname !== 'localhost' && hostname !== '127.0.0.1') {
    console.warn('[dashboard] DASHBOARD_URL uses plain HTTP. Sign-ins are not encrypted, so avoid public networks.');
  }
  return app.listen(env.DASHBOARD_PORT, env.DASHBOARD_HOST, () => {
    console.log(`[dashboard] listening on ${env.DASHBOARD_HOST}:${env.DASHBOARD_PORT}, public URL ${env.DASHBOARD_URL}`);
  });
}
