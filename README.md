# Toxtickety

A simple Discord ticket bot written in Python. You set everything up with slash commands in Discord.

## Set up the bot

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. On the **Bot** page, copy the token and turn on **Message Content Intent**.
3. Copy `.env.example` to `.env` and paste your token after `DISCORD_TOKEN=`.
4. Install and start the bot:

   ```bash
   pip install -r requirements.txt
   python bot.py
   ```

5. Open the invite link printed in the console and add the bot to your server.

You need Python 3.10 or newer.

## Host it on Kerit Cloud

1. Create a Python bot server.
2. On the **Files** page, upload `toxtickety-python.zip` and unarchive it. `bot.py` must be in the main folder.
3. Rename `.env.example` to `.env` and paste your token after `DISCORD_TOKEN=`.
4. Set the startup file to `bot.py`.
5. Run `pip install -r requirements.txt` in the console if the panel doesn't install packages by itself.
6. Start the server, then open the invite link printed in the console.

Tickets and settings are stored in the `data` folder. Keep that folder when you update the bot.

## Create your first panel

Run these in Discord. Each command needs the **Manage Server** permission.

```text
/panel create name:Complaints ticket_name:complaint-{count} support_role:@Support
/panel send panel:Complaints
```

Members can now press the button to open `complaint-0001`, `complaint-0002` and so on.

## Setup commands

| Command | What it does |
| --- | --- |
| `/panel create` | Create a ticket type |
| `/panel edit` | Change names, categories, channels, limits, options and the button |
| `/panel text` | Change the panel and welcome messages |
| `/panel add-role` | Add a support role |
| `/panel remove-role` | Remove a support role |
| `/panel add-question` | Ask a question before a ticket opens, up to 5 |
| `/panel clear-questions` | Remove all questions |
| `/panel send` | Post up to 5 ticket types on one message |
| `/panel view` | Show a panel's settings |
| `/panel list` | List your panels |
| `/panel delete` | Delete a panel |

## Ticket commands

| Command | Who can use it | What it does |
| --- | --- | --- |
| `/close` | Owner and support | Close the ticket |
| `/reopen` | Support | Reopen the ticket |
| `/delete` | Support | Delete the ticket |
| `/rename` | Support | Rename the ticket |
| `/add` | Support | Give a member access |
| `/remove` | Support | Remove a member's access |
| `/claim` | Support | Claim the ticket, or release your claim |
| `/transcript` | Support | Save an HTML transcript |
| `/help` | Everyone | Show a quick guide |

## Team roles

When someone creates a post in the team forum, the bot asks them for the team's name and color,
such as `[ICEG] ICEGURT E.C. #305aff`. The post's own text is ignored. It then creates a role with no permissions and posts a message with a ✅
reaction. Anyone who reacts gets the role, and removing the reaction takes it away. Deleting the post
deletes the role.

| Command | What it does |
| --- | --- |
| `/teams forum` | Choose the forum to watch, or switch to another one |
| `/teams above` | Place new team roles directly above a role, such as `@Membro`, so their color shows |
| `/teams view` | Show the current forum and how many team roles exist |
| `/teams off` | Stop handling new posts. Existing team roles keep working |

Only posts made after you choose the forum are handled. If the bot was offline, it catches up when it
starts: it handles new posts, gives roles to people who reacted, and deletes roles of deleted posts.
Reactions removed while it was offline are not caught up, so moderators remove those roles by hand.

## Placeholders

| Where | Placeholders |
| --- | --- |
| Channel names | `{count}` `{user}` `{panel}` |
| Welcome message | `{user}` `{support}` `{count}` `{panel}` `{server}` `{ticket}` |

Using `{support}` in the welcome message pings the panel's support roles.

## Language

Everything members see is in Brazilian Portuguese. Setup commands and messages for moderators are in English.

## Text under the bot's name

Set `BOT_STATUS` in `.env`, then restart the bot. Leave it empty to show nothing.
