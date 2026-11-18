import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { parseGuild, parsePanel, type GuildConfig, type PanelConfig } from '../config/schema.js';

export type TicketState = 'creating' | 'open' | 'closed' | 'deleting' | 'deleted';

export interface Panel {
  id: number;
  guildId: string;
  name: string;
  count: number;
  config: PanelConfig;
  createdAt: number;
}

export interface Ticket {
  id: number;
  guildId: string;
  panelId: number;
  channelId: string | null;
  ownerId: string;
  number: number;
  state: TicketState;
  isThread: boolean;
  claimedBy: string | null;
  addedUsers: string[];
  addedRoles: string[];
  form: string[];
  createReason: string | null;
  closeReason: string | null;
  deleteReason: string | null;
  claimReason: string | null;
  escalateReason: string | null;
  modMessageId: string | null;
  createdAt: number;
  claimedAt: number | null;
  closedAt: number | null;
  reopenedAt: number | null;
  deletedAt: number | null;
}

export interface AutomationJob {
  id: number;
  ticketId: number;
  automationId: string;
  kind: 'message' | 'trigger';
  runAt: number;
  expiresAt: number;
  seen: boolean;
}

export interface AuditEntry {
  id: number;
  userId: string;
  username: string;
  action: string;
  detail: string;
  at: number;
}

export interface Session {
  userId: string;
  username: string;
  avatar: string | null;
  expiresAt: number;
}

export type LimitReason = 'global' | 'openPerUser' | 'openTotal' | 'closedPerUser' | 'closedTotal';

export type ReserveResult = { ok: true; ticket: Ticket } | { ok: false; reason: LimitReason };

export interface ReserveLimits {
  globalLimit: number;
  bypassOpen: boolean;
  bypassClosed: boolean;
}

const ACTIVE = `('creating','open')`;

const MIGRATIONS = [
  `
  CREATE TABLE guilds (
    id TEXT PRIMARY KEY,
    config TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    config TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX panels_guild ON panels(guild_id);
  CREATE TABLE tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    panel_id INTEGER NOT NULL,
    channel_id TEXT UNIQUE,
    owner_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    state TEXT NOT NULL,
    is_thread INTEGER NOT NULL DEFAULT 0,
    claimed_by TEXT,
    added_users TEXT NOT NULL DEFAULT '[]',
    added_roles TEXT NOT NULL DEFAULT '[]',
    form TEXT NOT NULL DEFAULT '[]',
    create_reason TEXT,
    close_reason TEXT,
    delete_reason TEXT,
    claim_reason TEXT,
    escalate_reason TEXT,
    mod_message_id TEXT,
    created_at INTEGER NOT NULL,
    claimed_at INTEGER,
    closed_at INTEGER,
    reopened_at INTEGER,
    deleted_at INTEGER
  );
  CREATE INDEX tickets_panel_state ON tickets(panel_id, state);
  CREATE INDEX tickets_owner_state ON tickets(guild_id, owner_id, state);
  CREATE TABLE automation_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    automation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX jobs_due ON automation_jobs(run_at);
  CREATE INDEX jobs_ticket ON automation_jobs(ticket_id);
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
  );
  CREATE INDEX audit_guild ON audit(guild_id, at);
  CREATE TABLE sessions (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    avatar TEXT,
    expires_at INTEGER NOT NULL
  );
  `,
];

interface TicketRow {
  id: number;
  guild_id: string;
  panel_id: number;
  channel_id: string | null;
  owner_id: string;
  number: number;
  state: TicketState;
  is_thread: number;
  claimed_by: string | null;
  added_users: string;
  added_roles: string;
  form: string;
  create_reason: string | null;
  close_reason: string | null;
  delete_reason: string | null;
  claim_reason: string | null;
  escalate_reason: string | null;
  mod_message_id: string | null;
  created_at: number;
  claimed_at: number | null;
  closed_at: number | null;
  reopened_at: number | null;
  deleted_at: number | null;
}

interface PanelRow {
  id: number;
  guild_id: string;
  name: string;
  count: number;
  config: string;
  created_at: number;
}

interface JobRow {
  id: number;
  ticket_id: number;
  automation_id: string;
  kind: 'message' | 'trigger';
  run_at: number;
  expires_at: number;
  seen: number;
}

const toTicket = (row: TicketRow): Ticket => ({
  id: row.id,
  guildId: row.guild_id,
  panelId: row.panel_id,
  channelId: row.channel_id,
  ownerId: row.owner_id,
  number: row.number,
  state: row.state,
  isThread: row.is_thread === 1,
  claimedBy: row.claimed_by,
  addedUsers: JSON.parse(row.added_users) as string[],
  addedRoles: JSON.parse(row.added_roles) as string[],
  form: JSON.parse(row.form) as string[],
  createReason: row.create_reason,
  closeReason: row.close_reason,
  deleteReason: row.delete_reason,
  claimReason: row.claim_reason,
  escalateReason: row.escalate_reason,
  modMessageId: row.mod_message_id,
  createdAt: row.created_at,
  claimedAt: row.claimed_at,
  closedAt: row.closed_at,
  reopenedAt: row.reopened_at,
  deletedAt: row.deleted_at,
});

const toPanel = (row: PanelRow): Panel => ({
  id: row.id,
  guildId: row.guild_id,
  name: row.name,
  count: row.count,
  config: parsePanel(JSON.parse(row.config)),
  createdAt: row.created_at,
});

const toJob = (row: JobRow): AutomationJob => ({
  id: row.id,
  ticketId: row.ticket_id,
  automationId: row.automation_id,
  kind: row.kind,
  runAt: row.run_at,
  expiresAt: row.expires_at,
  seen: row.seen === 1,
});

const TICKET_COLUMNS = {
  channelId: 'channel_id',
  claimedBy: 'claimed_by',
  closeReason: 'close_reason',
  deleteReason: 'delete_reason',
  claimReason: 'claim_reason',
  escalateReason: 'escalate_reason',
  modMessageId: 'mod_message_id',
  claimedAt: 'claimed_at',
  closedAt: 'closed_at',
  reopenedAt: 'reopened_at',
  deletedAt: 'deleted_at',
  panelId: 'panel_id',
  number: 'number',
} as const;

export type TicketPatch = Partial<{ [K in keyof typeof TICKET_COLUMNS]: Ticket[K] }>;

export class Store {
  readonly db: Database.Database;
  private readonly guildCache = new Map<string, GuildConfig>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    for (let index = version; index < MIGRATIONS.length; index += 1) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[index]!);
        this.db.pragma(`user_version = ${index + 1}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  // Guild ----------------------------------------------------------------------------------------

  getGuild(guildId: string): GuildConfig {
    const cached = this.guildCache.get(guildId);
    if (cached) return cached;
    const row = this.db.prepare('SELECT config FROM guilds WHERE id = ?').get(guildId) as
      | { config: string }
      | undefined;
    const config = parseGuild(row ? JSON.parse(row.config) : {});
    this.guildCache.set(guildId, config);
    return config;
  }

  saveGuild(guildId: string, config: GuildConfig): void {
    this.db
      .prepare('INSERT INTO guilds (id, config) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config')
      .run(guildId, JSON.stringify(config));
    this.guildCache.delete(guildId);
  }

  // Panels ---------------------------------------------------------------------------------------

  createPanel(guildId: string, name: string, config: PanelConfig = parsePanel()): Panel {
    const result = this.db
      .prepare('INSERT INTO panels (guild_id, name, config, created_at) VALUES (?, ?, ?, ?)')
      .run(guildId, name, JSON.stringify(config), Date.now());
    return this.getPanel(Number(result.lastInsertRowid))!;
  }

  getPanel(id: number): Panel | undefined {
    const row = this.db.prepare('SELECT * FROM panels WHERE id = ?').get(id) as PanelRow | undefined;
    return row ? toPanel(row) : undefined;
  }

  listPanels(guildId: string): Panel[] {
    const rows = this.db.prepare('SELECT * FROM panels WHERE guild_id = ? ORDER BY id').all(guildId) as PanelRow[];
    return rows.map(toPanel);
  }

  updatePanel(id: number, name: string, config: PanelConfig): void {
    this.db.prepare('UPDATE panels SET name = ?, config = ? WHERE id = ?').run(name, JSON.stringify(config), id);
  }

  setPanelCount(id: number, count: number): void {
    this.db.prepare('UPDATE panels SET count = ? WHERE id = ?').run(count, id);
  }

  deletePanel(id: number): void {
    this.db.prepare('DELETE FROM panels WHERE id = ?').run(id);
  }

  nextPanelNumber(id: number): number {
    const row = this.db.prepare('UPDATE panels SET count = count + 1 WHERE id = ? RETURNING count').get(id) as {
      count: number;
    };
    return row.count;
  }

  // Tickets --------------------------------------------------------------------------------------

  /** Returns the limit a new ticket would break, if any. */
  limitProblem(panel: Panel, ownerId: string, limits: ReserveLimits): LimitReason | null {
    const count = (sql: string, ...args: unknown[]) =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE ${sql}`).get(...args) as { n: number }).n;
    const cfg = panel.config.limits;
    if (!limits.bypassOpen) {
      if (
        limits.globalLimit > 0 &&
        count(`guild_id = ? AND owner_id = ? AND state IN ${ACTIVE}`, panel.guildId, ownerId) >= limits.globalLimit
      ) {
        return 'global';
      }
      if (
        cfg.openPerUser > 0 &&
        count(`panel_id = ? AND owner_id = ? AND state IN ${ACTIVE}`, panel.id, ownerId) >= cfg.openPerUser
      ) {
        return 'openPerUser';
      }
      if (cfg.openTotal > 0 && count(`panel_id = ? AND state IN ${ACTIVE}`, panel.id) >= cfg.openTotal) {
        return 'openTotal';
      }
    }
    if (!limits.bypassClosed) {
      if (
        cfg.closedPerUser > 0 &&
        count(`panel_id = ? AND owner_id = ? AND state = 'closed'`, panel.id, ownerId) >= cfg.closedPerUser
      ) {
        return 'closedPerUser';
      }
      if (cfg.closedTotal > 0 && count(`panel_id = ? AND state = 'closed'`, panel.id) >= cfg.closedTotal) {
        return 'closedTotal';
      }
    }
    return null;
  }

  /**
   * Checks limits and claims a ticket number atomically, so two members pressing the button at the
   * same moment cannot both slip under a limit.
   */
  reserveTicket(panel: Panel, ownerId: string, limits: ReserveLimits, isThread: boolean): ReserveResult {
    return this.db
      .transaction((): ReserveResult => {
        const reason = this.limitProblem(panel, ownerId, limits);
        if (reason) return { ok: false, reason };
        const number = this.nextPanelNumber(panel.id);
        const result = this.db
          .prepare(
            `INSERT INTO tickets (guild_id, panel_id, owner_id, number, state, is_thread, created_at)
             VALUES (?, ?, ?, ?, 'creating', ?, ?)`,
          )
          .run(panel.guildId, panel.id, ownerId, number, isThread ? 1 : 0, Date.now());
        return { ok: true, ticket: this.getTicket(Number(result.lastInsertRowid))! };
      })
      .immediate();
  }

  activateTicket(id: number, channelId: string, form: string[], createReason: string | null): Ticket {
    this.db
      .prepare(`UPDATE tickets SET channel_id = ?, state = 'open', form = ?, create_reason = ? WHERE id = ?`)
      .run(channelId, JSON.stringify(form), createReason, id);
    return this.getTicket(id)!;
  }

  dropTicket(id: number): void {
    this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  }

  getTicket(id: number): Ticket | undefined {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined;
    return row ? toTicket(row) : undefined;
  }

  getTicketByChannel(channelId: string): Ticket | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tickets WHERE channel_id = ? AND state NOT IN ('deleted')`)
      .get(channelId) as TicketRow | undefined;
    return row ? toTicket(row) : undefined;
  }

  listTicketsByOwner(guildId: string, ownerId: string): Ticket[] {
    const rows = this.db
      .prepare(`SELECT * FROM tickets WHERE guild_id = ? AND owner_id = ? AND state IN ('open','closed')`)
      .all(guildId, ownerId) as TicketRow[];
    return rows.map(toTicket);
  }

  listLiveTickets(): Ticket[] {
    const rows = this.db.prepare(`SELECT * FROM tickets WHERE state IN ('open','closed')`).all() as TicketRow[];
    return rows.map(toTicket);
  }

  listTicketsInState(state: TicketState): Ticket[] {
    const rows = this.db.prepare('SELECT * FROM tickets WHERE state = ?').all(state) as TicketRow[];
    return rows.map(toTicket);
  }

  countLiveTickets(panelId: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tickets WHERE panel_id = ? AND state IN ('creating','open','closed','deleting')`)
      .get(panelId) as { n: number };
    return row.n;
  }

  /** Moves a ticket between states. Returns false if another action got there first. */
  transition(id: number, from: TicketState[], to: TicketState, patch: TicketPatch = {}): boolean {
    return this.db
      .transaction(() => {
        const marks = from.map(() => '?').join(',');
        const result = this.db
          .prepare(`UPDATE tickets SET state = ? WHERE id = ? AND state IN (${marks})`)
          .run(to, id, ...from);
        if (result.changes === 0) return false;
        this.patchTicket(id, patch);
        return true;
      })
      .immediate();
  }

  patchTicket(id: number, patch: TicketPatch): void {
    const entries = Object.entries(patch) as [keyof typeof TICKET_COLUMNS, unknown][];
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${TICKET_COLUMNS[key]} = ?`).join(', ');
    this.db.prepare(`UPDATE tickets SET ${assignments} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
  }

  setAdded(id: number, users: string[], roles: string[]): void {
    this.db
      .prepare('UPDATE tickets SET added_users = ?, added_roles = ? WHERE id = ?')
      .run(JSON.stringify(users), JSON.stringify(roles), id);
  }

  clearStaleReservations(): number {
    return this.db.prepare(`DELETE FROM tickets WHERE state = 'creating'`).run().changes;
  }

  // Automation jobs ------------------------------------------------------------------------------

  addJob(job: Omit<AutomationJob, 'id' | 'seen'>): void {
    this.db
      .prepare('INSERT INTO automation_jobs (ticket_id, automation_id, kind, run_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(job.ticketId, job.automationId, job.kind, job.runAt, job.expiresAt);
  }

  dueJobs(now: number, max = 100): AutomationJob[] {
    const rows = this.db
      .prepare('SELECT * FROM automation_jobs WHERE run_at <= ? ORDER BY run_at LIMIT ?')
      .all(now, max) as JobRow[];
    return rows.map(toJob);
  }

  ticketJobs(ticketId: number, kind?: AutomationJob['kind']): AutomationJob[] {
    const rows = (
      kind
        ? this.db.prepare('SELECT * FROM automation_jobs WHERE ticket_id = ? AND kind = ?').all(ticketId, kind)
        : this.db.prepare('SELECT * FROM automation_jobs WHERE ticket_id = ?').all(ticketId)
    ) as JobRow[];
    return rows.map(toJob);
  }

  updateJob(id: number, runAt: number, seen: boolean): void {
    this.db.prepare('UPDATE automation_jobs SET run_at = ?, seen = ? WHERE id = ?').run(runAt, seen ? 1 : 0, id);
  }

  deleteJob(id: number): void {
    this.db.prepare('DELETE FROM automation_jobs WHERE id = ?').run(id);
  }

  deleteTicketJobs(ticketId: number, kind?: AutomationJob['kind']): void {
    if (kind) this.db.prepare('DELETE FROM automation_jobs WHERE ticket_id = ? AND kind = ?').run(ticketId, kind);
    else this.db.prepare('DELETE FROM automation_jobs WHERE ticket_id = ?').run(ticketId);
  }

  // Audit ----------------------------------------------------------------------------------------

  addAudit(guildId: string, userId: string, username: string, action: string, detail = ''): void {
    this.db
      .prepare('INSERT INTO audit (guild_id, user_id, username, action, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(guildId, userId, username, action, detail, Date.now());
  }

  listAudit(guildId: string, max = 200): AuditEntry[] {
    return this.db
      .prepare(
        `SELECT id, user_id AS userId, username, action, detail, at FROM audit
         WHERE guild_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(guildId, max) as AuditEntry[];
  }

  // Sessions -------------------------------------------------------------------------------------

  createSession(hash: string, session: Session): void {
    this.db
      .prepare('INSERT INTO sessions (hash, user_id, username, avatar, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(hash, session.userId, session.username, session.avatar, session.expiresAt);
  }

  getSession(hash: string): Session | undefined {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    return this.db
      .prepare('SELECT user_id AS userId, username, avatar, expires_at AS expiresAt FROM sessions WHERE hash = ?')
      .get(hash) as Session | undefined;
  }

  deleteSession(hash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash);
  }

  // Statistics -----------------------------------------------------------------------------------

  stats(guildId: string, days = 30) {
    const since = Date.now() - days * 86_400_000;
    const panels = this.db
      .prepare(
        `SELECT p.id, p.name, p.created_at AS createdAt,
           COUNT(t.id) AS total,
           COALESCE(SUM(t.state = 'open'), 0) AS open,
           COALESCE(SUM(t.state = 'closed'), 0) AS closed
         FROM panels p LEFT JOIN tickets t ON t.panel_id = p.id AND t.state != 'creating'
         WHERE p.guild_id = ? GROUP BY p.id ORDER BY p.id`,
      )
      .all(guildId) as {
      id: number;
      name: string;
      createdAt: number;
      total: number;
      open: number;
      closed: number;
    }[];
    const activity = this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS count
         FROM tickets WHERE guild_id = ? AND created_at >= ? AND state != 'creating'
         GROUP BY day ORDER BY day`,
      )
      .all(guildId, since) as { day: string; count: number }[];
    const claimed = this.db
      .prepare(
        `SELECT claimed_by AS userId, COUNT(*) AS count FROM tickets
         WHERE guild_id = ? AND state = 'deleted' AND claimed_by IS NOT NULL
         GROUP BY claimed_by ORDER BY count DESC LIMIT 50`,
      )
      .all(guildId) as { userId: string; count: number }[];
    return { panels, activity, claimed };
  }
}
