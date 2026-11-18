/** An expected failure whose message is safe and useful to show to the member. */
export class UserError extends Error {
  override readonly name = 'UserError';
}

const DISCORD_ERRORS: Record<number, string> = {
  10003: 'That channel no longer exists.',
  40005: 'That file is too large for this server to upload.',
  30013: 'This server has reached the 500 channel limit.',
  50001: 'I cannot access that channel or category. Check my permissions there.',
  50013: 'I am missing permissions to do that. Check my role and the category permissions.',
  160002: 'This thread cannot be changed because it is archived.',
};

/** Turns a Discord API failure into an explanation server staff can act on. */
export function explainDiscordError(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? DISCORD_ERRORS[code] : undefined;
}
