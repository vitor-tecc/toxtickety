# Host Toxtickety on Kerit Cloud

These steps also work on other hosts that use the Pterodactyl panel.

## Before you start

In the [Discord Developer Portal](https://discord.com/developers/applications), open your application:

1. On the **Bot** page, copy the token and turn on **Server Members Intent** and **Message Content Intent**.
2. On the **OAuth2** page, copy the client secret.

## 1. Create the server

Create a Discord bot server on Kerit Cloud and choose **Node.js**. Pick version 22 or newer if the panel asks.

## 2. Upload the bot

1. Open the server's **Files** page.
2. Upload `toxtickety-host.zip` and choose **Unarchive**.
3. Check that `index.js` and `package.json` are directly in the main folder, and not inside another folder.
4. Delete the zip.

## 3. Add your settings

Find your server's address and port on its console or network page. Rename `.env.example` to `.env`, then fill it in:

```env
DISCORD_TOKEN=your bot token
DISCORD_CLIENT_SECRET=your client secret
DASHBOARD_URL=http://YOUR_SERVER_ADDRESS:YOUR_PORT
DASHBOARD_HOST=0.0.0.0
DASHBOARD_PORT=YOUR_PORT
```

Back in the Developer Portal, on the **OAuth2** page, add this redirect:

```text
http://YOUR_SERVER_ADDRESS:YOUR_PORT/auth/callback
```

## 4. Start it

If your panel has a **Startup** page, make sure the main file is `index.js`.

Start the server. If the panel doesn't install packages by itself, run `npm install` in the console and start it again.

The console shows `logged in as` and an invite link when the bot is ready. Use that link to add the bot to your server.

## 5. Create your first panel

Open your `DASHBOARD_URL`, sign in with Discord and create a panel. You can also run `/setup` in Discord.

## Update the bot

Run `npm run package` on your computer, upload the new zip and unarchive it over the old files. Keep your `.env` file and `data` folder.

## Back up your tickets

Everything is stored in the `data` folder. Stop the server, download that folder, then start the server again.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `needs Node.js 22.13 or newer` | Choose a newer Node.js version on the panel's Startup page |
| `Used disallowed intents` | Turn on both intents on the Developer Portal's **Bot** page |
| `Cannot find package` | Run `npm install` in the console |
| The dashboard does not open | Check that `DASHBOARD_URL` uses the port assigned to your server |
| Discord says the redirect is invalid | Make the OAuth2 redirect match `DASHBOARD_URL` plus `/auth/callback` exactly |
| The server restarts with no error | It ran out of memory. Upgrade to a plan with more RAM |

## Dashboard security

A plain `http://` address doesn't encrypt your sign-in, so avoid using the dashboard on public Wi-Fi. Dashboard sessions on HTTP end after 12 hours. For HTTPS, put the dashboard behind a domain and reverse proxy, then change `DASHBOARD_URL` to the `https://` address.
