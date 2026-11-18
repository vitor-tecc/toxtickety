import type { Message } from 'discord.js';
import type { Automation } from '../config/schema.js';
import type { AutomationJob, Panel, Ticket } from '../db/store.js';
import { onMatchingMessage, onWindowEnd, type Decision } from './automationRules.js';
import type { TicketChannel, TicketService } from './tickets.js';

const SEVEN_DAYS_MS = 7 * 86_400_000;
const TICK_MS = 15_000;

type TriggerEvent = Automation['event'];

/** Runs each panel's automations. Timers live in the database, so they survive restarts. */
export class AutomationEngine {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(private readonly tickets: TicketService) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private get store() {
    return this.tickets.store;
  }

  private rules(panel: Panel): Automation[] {
    return panel.config.automation.rules.filter((rule) => rule.enabled);
  }

  private startChecks(ticket: Ticket, panel: Panel, now = Date.now()): void {
    this.store.deleteTicketJobs(ticket.id, 'message');
    for (const rule of this.rules(panel)) {
      if (rule.kind !== 'messageCheck') continue;
      this.store.addJob({
        ticketId: ticket.id,
        automationId: rule.id,
        kind: 'message',
        runAt: now + rule.windowSeconds * 1000,
        expiresAt: now + SEVEN_DAYS_MS,
      });
    }
  }

  /** Message checks that are currently running for a ticket. */
  activeChecks(ticket: Ticket): number {
    return this.store.ticketJobs(ticket.id, 'message').length;
  }

  startManually(ticket: Ticket, panel: Panel): void {
    this.startChecks(ticket, panel);
  }

  stopManually(ticket: Ticket): void {
    this.store.deleteTicketJobs(ticket.id, 'message');
  }

  onEvent(ticket: Ticket, panel: Panel, event: TriggerEvent, now = Date.now()): void {
    for (const rule of this.rules(panel)) {
      if (rule.kind !== 'trigger' || rule.event !== event) continue;
      const runAt = now + rule.delaySeconds * 1000;
      this.store.addJob({
        ticketId: ticket.id,
        automationId: rule.id,
        kind: 'trigger',
        runAt,
        expiresAt: runAt + SEVEN_DAYS_MS,
      });
    }
    if (this.store.dueJobs(now, 1).length > 0) void this.tick();
  }

  onOpened(ticket: Ticket, panel: Panel): void {
    this.startChecks(ticket, panel);
    this.onEvent(ticket, panel, 'created');
  }

  /** Closing stops every pending automation, then starts the ones waiting for a closed ticket. */
  onClosed(ticket: Ticket, panel: Panel): void {
    this.store.deleteTicketJobs(ticket.id);
    this.onEvent(ticket, panel, 'closed');
  }

  onReopened(ticket: Ticket, panel: Panel): void {
    this.store.deleteTicketJobs(ticket.id);
    this.startChecks(ticket, panel);
    this.onEvent(ticket, panel, 'reopened');
  }

  onEscalated(ticket: Ticket, panel: Panel): void {
    this.store.deleteTicketJobs(ticket.id);
    this.startChecks(ticket, panel);
  }

  onDeleted(ticket: Ticket): void {
    this.store.deleteTicketJobs(ticket.id);
  }

  /** Handles a member leaving the server while they own tickets. */
  async onOwnerLeft(ticket: Ticket, panel: Panel): Promise<void> {
    this.onEvent(ticket, panel, 'ownerLeft');
    const guild = this.tickets.client.guilds.cache.get(ticket.guildId);
    const me = guild?.members.me;
    if (!me) return;
    const setting = panel.config.automation.missingUser;
    if (setting === 'delete') await this.tickets.delete(ticket, me, 'Ticket owner left the server');
    if (setting === 'close' && ticket.state === 'open') await this.tickets.close(ticket, me, 'Ticket owner left the server');
  }

  async onMessage(ticket: Ticket, message: Message): Promise<void> {
    const jobs = this.store.ticketJobs(ticket.id, 'message');
    if (jobs.length === 0) return;
    const panel = this.store.getPanel(ticket.panelId);
    if (!panel || !message.member) return;

    const now = Date.now();
    for (const job of jobs) {
      const rule = this.rules(panel).find((item) => item.id === job.automationId);
      if (!rule) {
        this.store.deleteJob(job.id);
        continue;
      }
      const matches =
        rule.from === 'anyone' ||
        (rule.from === 'owner' && message.author.id === ticket.ownerId) ||
        (rule.from === 'support' && this.tickets.isSupport(message.member, panel));
      if (matches) await this.apply(job, rule, ticket, onMatchingMessage(rule, job, now));
    }
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const job of this.store.dueJobs(now)) {
        await this.runDueJob(job, now).catch((error: unknown) => {
          console.warn('[automation] job failed:', error);
          this.store.deleteJob(job.id);
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runDueJob(job: AutomationJob, now: number): Promise<void> {
    const ticket = this.store.getTicket(job.ticketId);
    const panel = ticket && this.store.getPanel(ticket.panelId);
    const rule = panel && this.rules(panel).find((item) => item.id === job.automationId);
    if (!ticket || !panel || !rule || now > job.expiresAt) {
      this.store.deleteJob(job.id);
      return;
    }
    if (job.kind === 'trigger') {
      this.store.deleteJob(job.id);
      await this.execute(rule, ticket);
      return;
    }
    await this.apply(job, rule, ticket, onWindowEnd(rule, job, now));
  }

  private async apply(job: AutomationJob, rule: Automation, ticket: Ticket, decision: Decision): Promise<void> {
    if (decision.next && decision.next.runAt <= job.expiresAt) {
      this.store.updateJob(job.id, decision.next.runAt, decision.next.seen);
    } else {
      this.store.deleteJob(job.id);
    }
    if (decision.runAction) await this.execute(rule, ticket);
  }

  private async execute(rule: Automation, stale: Ticket): Promise<void> {
    const ticket = this.store.getTicket(stale.id);
    if (!ticket || (ticket.state !== 'open' && ticket.state !== 'closed')) return;
    const guild = this.tickets.client.guilds.cache.get(ticket.guildId);
    const me = guild?.members.me;
    if (!guild || !me) return;

    if (rule.action.type === 'close') {
      if (ticket.state === 'open') await this.tickets.close(ticket, me, `Automation: ${rule.name}`);
      return;
    }
    if (rule.action.type === 'delete') {
      await this.tickets.delete(ticket, me, `Automation: ${rule.name}`);
      return;
    }
    const command = this.store
      .getGuild(guild.id)
      .customCommands.find((item) => item.name === rule.action.commandName);
    const channel = (await this.tickets.channelOf(guild, ticket)) as TicketChannel | null;
    if (command && channel) await this.tickets.runCustomCommand(command, { guild, channel, author: me, ticket });
  }
}
