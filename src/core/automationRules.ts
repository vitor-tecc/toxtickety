import type { Automation } from '../config/schema.js';

export interface JobWindow {
  runAt: number;
  seen: boolean;
}

export interface Decision {
  runAction: boolean;
  next: JobWindow | null;
}

const nextWindow = (rule: Automation, now: number): JobWindow => ({
  runAt: now + rule.windowSeconds * 1000,
  seen: false,
});

const afterAction = (rule: Automation, now: number): Decision => ({
  runAction: true,
  next: rule.afterAction === 'keepChecking' && rule.repeat === 'untilStopped' ? nextWindow(rule, now) : null,
});

/** What a message check does when a matching message arrives during its window. */
export function onMatchingMessage(rule: Automation, job: JobWindow, now: number): Decision {
  if (rule.checkType === 'found') return afterAction(rule, now);
  if (rule.onMessageInWindow === 'restart') return { runAction: false, next: nextWindow(rule, now) };
  return { runAction: false, next: { runAt: job.runAt, seen: true } };
}

/** What a message check does when its window runs out. */
export function onWindowEnd(rule: Automation, job: JobWindow, now: number): Decision {
  const repeat = rule.repeat === 'untilStopped' ? nextWindow(rule, now) : null;
  if (rule.checkType === 'found') return { runAction: false, next: repeat };
  if (job.seen) return { runAction: false, next: repeat };
  return afterAction(rule, now);
}
