"""Team roles: a new post in the team forum gets its own role, which members join by reacting."""

from __future__ import annotations

import asyncio
import logging
import re
import time

import discord

log = logging.getLogger("toxtickety.teams")

REACTION = "✅"
MAX_ROLE_NAME = 100
STARTER_WAIT_SECONDS = 2
DISCORD_ERRORS = (discord.HTTPException, discord.RateLimited)

PROMPT = (
    "{owner} Para criar o cargo do seu time, envie **a tag, o nome e a cor em hexadecimal** na mesma mensagem.\n"
    "Exemplo: `[ICEG] ICEGURT E.C. #305aff`\n"
    "Para escolher a cor, pesquise **color picker** no Google."
)
NOT_UNDERSTOOD = "Não entendi. Envie a tag, o nome e a cor juntos, por exemplo: `[ICEG] ICEGURT E.C. #305aff`."
NAME_TOO_LONG = f"O nome do time pode ter no máximo {MAX_ROLE_NAME} caracteres."
ROLE_LIMIT = "Este servidor atingiu o limite de 250 cargos do Discord. Avise a moderação."
NO_PERMISSION = "Não consegui criar o cargo. Avise a moderação."
TRY_LATER = "O Discord está limitando a criação de cargos agora. Tente de novo daqui a pouco."
REACTION_MESSAGE = "Clique na reação {emoji} abaixo para receber o cargo {role}.\nPara sair do time, é só remover a reação."

# A six-digit code may be written with or without "#". A three-digit one needs "#",
# so a short word in the team name is never read as a color.
HEX = re.compile(r"(?:#([0-9a-fA-F]{6})|(?<![\w#])([0-9a-fA-F]{6})|#([0-9a-fA-F]{3}))(?![\w])")


def parse_team(text: str) -> tuple[str, discord.Colour] | None:
    """Reads "Team name #RRGGBB" in any order. Returns None when there is no name or no color."""
    matches = list(HEX.finditer(text))
    if not matches:
        return None
    match = matches[-1]
    code = next(group for group in match.groups() if group)
    if len(code) == 3:
        code = "".join(digit * 2 for digit in code)
    name = (text[: match.start()] + " " + text[match.end() :]).strip()
    name = re.sub(r"\s+", " ", name).strip(" -–—:|,;")
    if not name:
        return None
    value = int(code, 16)
    # Discord treats black as "no color", so use the nearest visible black instead.
    return name, discord.Colour(value or 0x010101)


async def send_in_new_thread(thread: discord.Thread, content: str, **kwargs) -> discord.Message:
    """A forum post's first message can arrive a moment after the post itself, so wait and retry."""
    for attempt in range(3):
        try:
            return await thread.send(content, **kwargs)
        except discord.HTTPException as error:
            if error.code != 40058 or attempt == 2:
                raise
            await asyncio.sleep(STARTER_WAIT_SECONDS)
    raise RuntimeError("unreachable")


async def start_team(db, thread: discord.Thread) -> None:
    """Asks the person who made the post for their team's name and color."""
    if thread.owner_id is None or db.get_team(thread.id):
        return
    owner = thread.guild.get_member(thread.owner_id)
    if owner is not None and owner.bot:
        return
    if not db.add_team(thread.guild.id, thread.id, thread.owner_id):
        return
    try:
        await thread.join()
    except DISCORD_ERRORS:
        pass
    try:
        await send_in_new_thread(
            thread,
            PROMPT.format(owner=f"<@{thread.owner_id}>"),
            allowed_mentions=discord.AllowedMentions(users=True, roles=False, everyone=False),
        )
    except DISCORD_ERRORS as error:
        log.warning("Could not ask for the team name in thread %s: %s", thread.id, error)
        db.delete_team(thread.id)


async def handle_message(client: discord.Client, db, message: discord.Message) -> None:
    """Turns the post owner's reply into a role and a reaction message, then goes quiet."""
    # A forum post's own text is a message whose ID matches the post's ID. It isn't the answer.
    if message.id == message.channel.id:
        return
    team = db.get_team(message.channel.id)
    if team is None or team["state"] != "waiting" or message.author.id != team["owner_id"]:
        return
    parsed = parse_team(message.content)
    if parsed is None:
        await reply(message, NOT_UNDERSTOOD)
        return
    name, colour = parsed
    if len(name) > MAX_ROLE_NAME:
        await reply(message, NAME_TOO_LONG)
        return
    if not db.set_team_state(team["thread_id"], "waiting", "creating"):
        return

    guild = message.guild
    try:
        role = await guild.create_role(
            name=name,
            colour=colour,
            permissions=discord.Permissions.none(),
            mentionable=False,
            reason=f"Team role requested by {message.author} in thread {message.channel.id}",
        )
    except discord.RateLimited:
        db.set_team_state(team["thread_id"], "creating", "waiting")
        await reply(message, TRY_LATER)
        return
    except discord.HTTPException as error:
        db.set_team_state(team["thread_id"], "creating", "waiting")
        await reply(message, ROLE_LIMIT if error.code == 30005 else NO_PERMISSION)
        log.warning("Could not create a team role: %s", error)
        return

    await place_role(client, db, guild, role.id)

    try:
        notice = await message.channel.send(
            REACTION_MESSAGE.format(emoji=REACTION, role=role.mention),
            allowed_mentions=discord.AllowedMentions.none(),
        )
        await notice.add_reaction(REACTION)
    except DISCORD_ERRORS as error:
        log.warning("Could not post the reaction message, removing role %s: %s", role.id, error)
        await delete_role(client, guild.id, role.id)
        db.set_team_state(team["thread_id"], "creating", "waiting")
        return
    db.finish_team(team["thread_id"], role.id, notice.id)


async def place_role(client: discord.Client, db, guild: discord.Guild, role_id: int) -> None:
    """Moves a new team role just above the chosen role, so its color shows in members' names.

    Discord shows the color of a member's highest colored role, and new roles start at the bottom.
    Positions are read fresh from Discord, because the cached ones can lag right after a role is
    created. If the move fails, the role still works, it just sits lower in the list.
    """
    setting = db.team_forum(guild.id)
    anchor_id = setting.get("above_role_id") if setting else None
    if not anchor_id:
        return
    try:
        roles = sorted((r for r in await guild.fetch_roles() if not r.is_default()), key=lambda r: (r.position, r.id))
        ids = [r.id for r in roles]
        if role_id not in ids or anchor_id not in ids:
            return
        old_index = ids.index(role_id)
        ids.remove(role_id)
        new_index = ids.index(anchor_id) + 1
        ids.insert(new_index, role_id)
        low, high = min(old_index, new_index), max(old_index, new_index)
        # Only the roles between the old and new spot change, and all of them sit below the anchor,
        # which the bot is allowed to manage.
        payload = [{"id": ids[index], "position": index + 1} for index in range(low, high + 1)]
        if len(payload) > 1:
            await client.http.move_role_position(guild.id, payload, reason="Place team role above the chosen role")
    except DISCORD_ERRORS as error:
        log.warning("Could not move team role %s above %s: %s", role_id, anchor_id, error)


def can_place_above(guild: discord.Guild, anchor: discord.Role) -> bool:
    """The bot can only place roles below its own highest role."""
    return anchor.position < guild.me.top_role.position and guild.me.guild_permissions.manage_roles


async def reply(message: discord.Message, text: str) -> None:
    try:
        await message.reply(text, mention_author=False, allowed_mentions=discord.AllowedMentions.none())
    except DISCORD_ERRORS:
        pass


async def handle_reaction(client: discord.Client, db, payload: discord.RawReactionActionEvent, added: bool) -> None:
    """Adds or removes the team role when someone reacts to the reaction message."""
    if payload.guild_id is None or str(payload.emoji) != REACTION or payload.user_id == client.user.id:
        return
    team = db.team_by_message(payload.message_id)
    if team is None or team["role_id"] is None:
        return
    if payload.member is not None and payload.member.bot:
        return
    change = client.http.add_role if added else client.http.remove_role
    reason = "Joined a team by reacting" if added else "Left a team by removing the reaction"
    try:
        await change(payload.guild_id, payload.user_id, team["role_id"], reason=reason)
    except discord.NotFound:
        pass  # The member left the server, or a moderator deleted the role.
    except DISCORD_ERRORS as error:
        log.warning("Could not update team role %s for %s: %s", team["role_id"], payload.user_id, error)


async def delete_role(client: discord.Client, guild_id: int, role_id: int) -> None:
    try:
        await client.http.delete_role(guild_id, role_id, reason="Team post was deleted")
    except discord.NotFound:
        pass
    except DISCORD_ERRORS as error:
        log.warning("Could not delete team role %s: %s", role_id, error)


async def handle_thread_deleted(client: discord.Client, db, guild_id: int, thread_id: int) -> None:
    team = db.get_team(thread_id)
    if team is None:
        return
    db.delete_team(thread_id)
    if team["role_id"]:
        await delete_role(client, guild_id, team["role_id"])


async def recover(client: discord.Client, db) -> None:
    """Catches up on what happened while the bot was offline."""
    for team in db.all_teams():
        guild = client.get_guild(team["guild_id"])
        if guild is None:
            continue
        # Archived posts are not in the cache, so only a "not found" answer means the post is gone.
        try:
            thread = await client.fetch_channel(team["thread_id"])
        except discord.NotFound:
            await handle_thread_deleted(client, db, guild.id, team["thread_id"])
            continue
        except DISCORD_ERRORS:
            continue
        if team["state"] == "creating":
            db.set_team_state(team["thread_id"], "creating", "waiting")
        if team["state"] == "done" and team["role_id"] and guild.get_role(team["role_id"]):
            await add_missed_reactions(client, thread, team)

    for setting in db.team_forums():
        guild = client.get_guild(setting["guild_id"])
        forum = guild.get_channel(setting["forum_id"]) if guild else None
        if not isinstance(forum, discord.ForumChannel):
            continue
        for thread in forum.threads:
            if thread.created_at and thread.created_at.timestamp() >= setting["since"]:
                await start_team(db, thread)


async def add_missed_reactions(client: discord.Client, thread: discord.Thread, team: dict) -> None:
    try:
        message = await thread.fetch_message(team["message_id"])
    except DISCORD_ERRORS:
        return
    reaction = discord.utils.find(lambda item: str(item.emoji) == REACTION, message.reactions)
    if reaction is None:
        return
    try:
        async for user in reaction.users():
            if not user.bot:
                await client.http.add_role(thread.guild.id, user.id, team["role_id"], reason="Joined a team by reacting")
    except DISCORD_ERRORS as error:
        log.warning("Could not catch up on reactions for team role %s: %s", team["role_id"], error)


def now() -> int:
    return int(time.time())
