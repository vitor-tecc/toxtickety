import { z } from 'zod';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

// Hosting panels such as Pterodactyl assign a public port and pass it in SERVER_PORT.
const assignedPort = process.env.SERVER_PORT;

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_SECRET: optional(z.string()),
  DASHBOARD_URL: optional(z.url().transform((url) => url.replace(/\/$/, ''))),
  DASHBOARD_HOST: z.string().default(assignedPort ? '0.0.0.0' : '127.0.0.1'),
  DASHBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(Number(assignedPort) || 3000),
  DATABASE_PATH: z.string().default('./data/toxtickety.db'),
  DEV_GUILD_ID: optional(z.string().regex(/^\d{17,20}$/)),
  BOT_STATUS: z.string().default('your tickets'),
});

export type Env = z.output<typeof schema>;

export function loadEnv(): Env {
  const parsed = schema.safeParse({
    ...process.env,
    // A panel's assigned port always wins, because no other port is reachable from outside.
    DASHBOARD_PORT: assignedPort ?? process.env.DASHBOARD_PORT,
    DASHBOARD_HOST: assignedPort ? '0.0.0.0' : process.env.DASHBOARD_HOST,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment:\n${problems.join('\n')}`);
  }
  return parsed.data;
}
