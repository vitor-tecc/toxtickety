# Toxtickety

A self-hosted Discord ticket bot you can fully customize. It covers Ticket Tool's core and Premium features, apart from the three integrations listed under [Features](#features), and everything is managed from your own web dashboard.

For example, to get channels named `complaint-0001`, open a panel in the dashboard and set **Ticket channel name** to `complaint-{count}`.

## Set up

You need [Node.js 22 or newer](https://nodejs.org) or Docker.

### 1. Create the Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. On the **Bot** page, copy the token and turn on **Server Members Intent** and **Message Content Intent**.
3. On the **OAuth2** page, copy the client secret and add this redirect: `http://localhost:3000/auth/callback`. If you host the dashboard on a domain, use that address instead.

### 2. Configure

```bash
cp .env.example .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET` and `DASHBOARD_URL`.

### 3. Run

With Node.js:

```bash
npm ci
npm run build
npm start
```

Or with Docker:

```bash
docker compose up -d --build
```

The bot prints an invite link when it starts. Use it to add the bot to your server.

### 4. Create your first panel

Run `/setup` in the channel where members should open tickets, or sign in to the dashboard and create a panel there.

Keep the bot's role above any roles it needs to add or remove from members.

If you put the dashboard on the internet, serve it over HTTPS through a reverse proxy such as Caddy or Nginx, and set `DASHBOARD_URL` to the `https://` address.

## Features

| Ticket Tool feature | Toxtickety |
| --- | --- |
| Button, dropdown and multi-panel ticket creation | Yes |
| Command-style tickets (`$new`, `$ticket`, `/new`) | Yes |
| Thread-style tickets | Yes |
| Custom channel names for open, closed and claimed tickets | Yes |
| Ticket numbering, padding and editable counters | Yes |
| Support and additional roles | Yes |
| Open, closed and overflow categories | Yes |
| Permissions for open and closed tickets | Yes |
| Two-step close and keeping closed tickets | Yes |
| Customizable messages, embeds and buttons | Yes |
| Question forms before opening a ticket | Yes |
| Claiming, with all claim restrictions | Yes |
| Escalating tickets between panels | Yes |
| HTML transcripts, auto-save and DM delivery | Yes |
| Logging channel | Yes |
| Automations and event triggers | Yes |
| Ticket limits and opening hours | Yes |
| Roles added or removed on ticket events | Yes |
| Private staff threads on tickets | Yes |
| Custom commands (exact, wildcard and regex) | Yes |
| Per-command permissions | Yes |
| Prefix and slash commands | Yes |
| All message variables | Yes |
| Statistics and dashboard history | Yes |
| Config backup and restore | Yes, as a downloadable file |
| Google Drive transcripts | Not yet |
| Bloxlink (Roblox) integration | Not yet |
| Storage categories that recycle deleted channels | Not yet |

## Commands

Every command works as a slash command and with your prefix (`$` by default).

| Command | What it does |
| --- | --- |
| `setup` | Create a ready-to-use panel in this channel |
| `panel [id]` | Send a panel, or list them |
| `new [user] [panel] [reason]` | Open a ticket |
| `close [reason]` | Close this ticket |
| `open` | Reopen this ticket |
| `delete [reason]` | Delete this ticket |
| `rename <name>` | Rename this ticket |
| `add <member or role>` | Give access to this ticket |
| `remove <member or role>` | Remove access to this ticket |
| `claim [user] [reason]` | Claim this ticket |
| `unclaim` | Release this ticket |
| `closerequest` | Ask whether this ticket can be closed |
| `escalate [reason]` | Move this ticket to another panel |
| `transcript [channel] [lines]` | Save a transcript |
| `automation [start or stop]` | Control this ticket's automations |
| `stats` | Show ticket statistics |
| `permissionlevel [user]` | Show a permission level |
| `debug` | Show troubleshooting details |
| `id [target]` | Show an ID |
| `ping` | Show the bot's latency |
| `help` | List commands |

## Customize the code

| To change | Edit |
| --- | --- |
| Settings and their defaults | `src/config/schema.ts`. New settings appear in the dashboard automatically |
| Ticket behavior | `src/core/tickets.ts` |
| Message variables | `src/core/variables.ts` |
| Commands | `src/discord/commands.ts` |
| Dashboard | `src/dashboard/public/` |

```bash
npm run dev        # Run with automatic reload
npm test           # Run the tests
npm run typecheck  # Check types
```

Set `DEV_GUILD_ID` while developing so slash command changes appear right away.

Your data is stored in one SQLite file at `DATABASE_PATH`. Back up that file to keep your tickets and settings.
