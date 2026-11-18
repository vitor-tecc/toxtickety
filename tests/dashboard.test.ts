import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { ChannelType } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePanel } from '../src/config/schema.js';
import { TicketService } from '../src/core/tickets.js';
import { createDashboardApp } from '../src/dashboard/server.js';
import { Store } from '../src/db/store.js';
import { fakeChannel, fakeClient, fakeGuild, fakeMember } from './helpers/fakes.js';

const ADMIN = '100000000000000011';
const MEMBER = '100000000000000012';
const sign = (store: Store, token: string, userId: string) =>
  store.createSession(createHash('sha256').update(token).digest('hex'), {
    userId,
    username: userId,
    avatar: null,
    expiresAt: Date.now() + 60_000,
  });

describe('dashboard API', () => {
  const store = new Store(':memory:');
  const guild = fakeGuild();
  const client = fakeClient(guild);
  const service = new TicketService(client, store, 0);
  fakeMember(guild, ADMIN, 'admin', { admin: true });
  fakeMember(guild, MEMBER, 'member');
  const channel = fakeChannel(guild, 'tickets', ChannelType.GuildText);
  const foreign = store.createPanel('999999999999999999', 'Other server');
  let server: Server;
  let base: string;

  const call = (path: string, options: { method?: string; body?: unknown; token?: string; csrf?: boolean; origin?: string } = {}) =>
    fetch(`${base}/api${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Cookie: `toxtickety_session=${options.token}` } : {}),
        ...(options.csrf === false ? {} : { 'X-Toxtickety': '1' }),
        ...(options.origin ? { Origin: options.origin } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

  beforeAll(async () => {
    sign(store, 'admin-token', ADMIN);
    sign(store, 'member-token', MEMBER);
    const app = createDashboardApp({ client, store, service } as never, { publicUrl: 'http://localhost:3000', clientSecret: 'x' });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => server.close());

  it('requires a session', async () => {
    expect((await call('/me')).status).toBe(401);
    expect((await call(`/guilds/${guild.id}`, { token: 'made-up' })).status).toBe(401);
  });

  it('only lets server admins in', async () => {
    expect((await call(`/guilds/${guild.id}`, { token: 'member-token' })).status).toBe(403);
    expect(await (await call('/guilds', { token: 'member-token' })).json()).toEqual([]);
    expect((await call(`/guilds/${guild.id}`, { token: 'admin-token' })).status).toBe(200);
  });

  it('blocks forged cross-site requests', async () => {
    const body = { name: 'Forged' };
    const path = `/guilds/${guild.id}/panels`;
    expect((await call(path, { method: 'POST', body, token: 'admin-token', csrf: false })).status).toBe(403);
    expect((await call(path, { method: 'POST', body, token: 'admin-token', origin: 'https://evil.example' })).status).toBe(403);
  });

  it('saves a complaint panel', async () => {
    const created = await call(`/guilds/${guild.id}/panels`, { method: 'POST', body: { name: 'Complaints' }, token: 'admin-token' });
    expect(created.status).toBe(201);
    const panel = (await created.json()) as { id: number; config: ReturnType<typeof parsePanel> };
    panel.config.ticket.openedName = 'complaint-{count}';
    const saved = await call(`/guilds/${guild.id}/panels/${panel.id}`, {
      method: 'PUT',
      body: { name: 'Complaints', count: 41, config: panel.config },
      token: 'admin-token',
    });
    expect(saved.status).toBe(200);
    expect(store.getPanel(panel.id)!.config.ticket.openedName).toBe('complaint-{count}');
    expect(store.getPanel(panel.id)!.count).toBe(41);
    expect(store.listAudit(guild.id).some((entry) => entry.action === 'Updated panel')).toBe(true);
  });

  it('rejects invalid settings with the field that is wrong', async () => {
    const config = parsePanel();
    const response = await call(`/guilds/${guild.id}/panels/${store.listPanels(guild.id)[0]!.id}`, {
      method: 'PUT',
      body: { name: 'Bad', config: { ...config, general: { ...config.general, padding: 99 } } },
      token: 'admin-token',
    });
    expect(response.status).toBe(400);
    const data = (await response.json()) as { issues: { path: string }[] };
    expect(data.issues[0]!.path).toBe('config.general.padding');
  });

  it('never exposes another server’s panels', async () => {
    const path = `/guilds/${guild.id}/panels/${foreign.id}`;
    expect((await call(path, { method: 'DELETE', token: 'admin-token' })).status).toBe(404);
    expect(store.getPanel(foreign.id)).toBeTruthy();
  });

  it('sends panels to a channel', async () => {
    const panel = store.listPanels(guild.id)[0]!;
    const response = await call(`/guilds/${guild.id}/panels/${panel.id}/send`, {
      method: 'POST',
      body: { channelId: channel.id },
      token: 'admin-token',
    });
    expect(response.status).toBe(200);
    expect(channel.sent).toHaveLength(1);
  });

  it('limits backups to the server owner', async () => {
    expect((await call(`/guilds/${guild.id}/backup`, { token: 'admin-token' })).status).toBe(403);
    fakeMember(guild, guild.ownerId, 'owner');
    sign(store, 'owner-token', guild.ownerId);
    const backup = await call(`/guilds/${guild.id}/backup`, { token: 'owner-token' });
    expect(backup.status).toBe(200);
    const before = store.listPanels(guild.id).length;
    const restored = await call(`/guilds/${guild.id}/restore`, { method: 'POST', body: await backup.json(), token: 'owner-token' });
    expect(restored.status).toBe(200);
    expect(store.listPanels(guild.id).length).toBe(before * 2);
  });

  it('publishes a schema the forms can use', async () => {
    const schema = (await (await call('/schema', { token: 'admin-token' })).json()) as { panel: { properties: Record<string, { title: string }> } };
    expect(schema.panel.properties.ticket!.title).toBe('Ticket');
  });

  it('sets a strict content security policy', async () => {
    const response = await fetch(`${base}/`);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
  });
});
