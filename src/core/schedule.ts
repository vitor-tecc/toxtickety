import type { Schedule } from '../config/schema.js';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

const toMinutes = (clock: string) => {
  const [hours, minutes] = clock.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

/** True when the panel is open at `date` in the schedule's own timezone. */
export function isWithinSchedule(schedule: Schedule, date: Date): boolean {
  if (!schedule.enabled) return true;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const day = DAYS.find((name) => name === read('weekday').toLowerCase());
  if (!day) return false;
  const now = Number(read('hour')) * 60 + Number(read('minute'));
  return schedule[day].some((window) => {
    const start = toMinutes(window.start);
    const end = toMinutes(window.end);
    // A window such as 22:00 to 02:00 runs past midnight on the day it starts.
    if (end <= start) return now >= start;
    return now >= start && now < end;
  }) || overnightFromYesterday(schedule, day, now);
}

function overnightFromYesterday(schedule: Schedule, day: (typeof DAYS)[number], now: number): boolean {
  const yesterday = DAYS[(DAYS.indexOf(day) + 6) % 7]!;
  return schedule[yesterday].some((window) => {
    const start = toMinutes(window.start);
    const end = toMinutes(window.end);
    return end <= start && now < end;
  });
}
