"""Toxtickety: a simple Discord ticket bot that you set up with slash commands."""

from __future__ import annotations

import asyncio
import io
import logging
import os
import re
import time
from typing import Literal, Optional

import discord
from discord import app_commands
from dotenv import load_dotenv

from database import Database, LimitReached
from transcript import render_transcript

load_dotenv()
log = logging.getLogger("toxtickety")
db = Database(os.getenv("DATABASE_PATH", "data/tickets.db"))

DELETE_DELAY_SECONDS = 5
BRAND_COLOR = discord.Color.from_str("#5865F2")
BUTTON_COLORS = {
    "blue": discord.ButtonStyle.primary,
    "gray": discord.ButtonStyle.secondary,
    "green": discord.ButtonStyle.success,
    "red": discord.ButtonStyle.danger,
}
ButtonColor = Literal["blue", "gray", "green", "red"]
ClearOption = Literal["open_category", "closed_category", "transcript_channel", "log_channel"]


class UserError(app_commands.AppCommandError):
    """A problem to show directly to the person who triggered it."""


# discord.py raises RateLimited separately from HTTPException when a wait would be too long,
# so every place that rolls back after a failed Discord request must catch both.
DISCORD_ERRORS = (discord.HTTPException, discord.RateLimited)


def patch_ratelimit() -> None:
    """Works around a discord.py bug, present in 2.7.1.

    With max_ratelimit_timeout set, discord.py refuses a request whenever its rate-limit bucket
    resets further away than the timeout, without checking whether requests are still left in it.
    Channel creation uses a bucket that resets after about 24 hours, so after one ticket every
    further ticket failed locally with "Retry in 8xxxx seconds", although Discord had refused nothing.
    Here, a request is let through whenever the bucket still has requests left.
    """
    from discord.http import Ratelimit

    if getattr(Ratelimit.acquire, "_toxtickety_patched", False):
        return
    original = Ratelimit.acquire

    async def acquire(self) -> None:
        if self.remaining > 0 and not self.is_expired():
            self._last_request = self._loop.time()
            self.remaining -= 1
            self.outgoing += 1
            return
        await original(self)

    acquire._toxtickety_patched = True
    Ratelimit.acquire = acquire


async def ratelimit_patch_works() -> bool:
    """Checks the workaround still fits discord.py's internals, so an upgrade that breaks it is logged."""
    try:
        from discord.http import Ratelimit

        bucket = Ratelimit(30.0)
        bucket.limit, bucket.remaining = 5, 4
        bucket.expires = asyncio.get_running_loop().time() + 86400
        await bucket.acquire()
        return bucket.remaining == 3
    except Exception:
        return False


patch_ratelimit()


def wait_text(seconds: float) -> str:
    if seconds >= 3600:
        hours = round(seconds / 3600)
        return f"about {hours} hour{'s' if hours != 1 else ''}"
    minutes = max(1, round(seconds / 60))
    return f"about {minutes} minute{'s' if minutes != 1 else ''}"


def rate_limit_message(error: discord.RateLimited, action: str) -> str:
    return (
        f"Discord is temporarily blocking me from {action} on this server. "
        f"Please try again in {wait_text(error.retry_after)}."
    )


# Text helpers


def fill(template: str, **values) -> str:
    """Replaces {placeholders} once, so text typed by members is never expanded."""
    return re.sub(r"\{(\w+)\}", lambda match: str(values.get(match[1], match[0])), template)


def channel_name(template: str, panel: dict, number: int, username: str = "user") -> str:
    text = fill(template, count=str(number).zfill(panel["padding"]), user=username, username=username, panel=panel["name"])
    text = re.sub(r"[\s_]+", "-", text.lower())
    text = re.sub(r"[^\w-]", "", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text[:100] or f"ticket-{number}"


def message_text(template: str, panel: dict, ticket: dict, guild: discord.Guild) -> str:
    return fill(
        template,
        user=f"<@{ticket['owner_id']}>",
        support=" ".join(f"<@&{role}>" for role in panel["support_roles"]),
        count=str(ticket["number"]).zfill(panel["padding"]),
        panel=panel["name"],
        server=guild.name,
        ticket=f"<#{ticket['channel_id']}>",
    )


def valid_emoji(value: str) -> bool:
    return bool(re.fullmatch(r"<a?:\w{2,32}:\d{17,20}>", value)) or bool(
        re.search(r"[\U0001F000-\U0001FAFF←-⯿️]", value)
    )


# Permissions


def is_support(member: discord.Member, panel: dict) -> bool:
    if member.guild_permissions.manage_guild:
        return True
    return any(role.id in panel["support_roles"] for role in member.roles)


def require_support(member: discord.Member, panel: dict) -> None:
    if not is_support(member, panel):
        raise UserError("Only the support team can do that.")


def held(guild: discord.Guild, **permissions) -> discord.PermissionOverwrite:
    """Discord refuses permission changes the bot does not have itself, so those are left out."""
    mine = guild.me.guild_permissions
    return discord.PermissionOverwrite(**{name: value for name, value in permissions.items() if getattr(mine, name)})


async def find_member(guild: discord.Guild, user_id: int) -> discord.Member | None:
    member = guild.get_member(user_id)
    if member:
        return member
    try:
        return await guild.fetch_member(user_id)
    except discord.NotFound:
        return None


async def ticket_overwrites(guild: discord.Guild, panel: dict, ticket: dict, closed: bool) -> dict:
    chat = dict(
        view_channel=True,
        send_messages=True,
        read_message_history=True,
        attach_files=True,
        embed_links=True,
        add_reactions=True,
    )
    overwrites = {
        guild.default_role: discord.PermissionOverwrite(view_channel=False),
        guild.me: held(guild, **chat, manage_channels=True, manage_messages=True),
    }
    for role_id in panel["support_roles"]:
        role = guild.get_role(role_id)
        if role:
            overwrites[role] = held(guild, **chat)
    for user_id in [ticket["owner_id"], *ticket["added_users"]]:
        member = await find_member(guild, user_id)
        if member is None:
            continue
        if not closed:
            overwrites[member] = held(guild, **chat)
        elif not is_support(member, panel):
            overwrites[member] = discord.PermissionOverwrite(view_channel=False)
    return overwrites


# Discord allows two channel renames every ten minutes. Extra renames are skipped, not queued.


class RenameGuard:
    WINDOW_SECONDS = 600
    LIMIT = 2

    def __init__(self):
        self.history: dict[int, list[float]] = {}

    def allow(self, channel_id: int, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        recent = [at for at in self.history.get(channel_id, []) if now - at < self.WINDOW_SECONDS]
        allowed = len(recent) < self.LIMIT
        if allowed:
            recent.append(now)
        self.history[channel_id] = recent
        return allowed


renames = RenameGuard()


async def edit_ticket_channel(channel: discord.TextChannel, name: str | None = None, **fields) -> None:
    if name and name != channel.name and renames.allow(channel.id):
        fields["name"] = name
    if not fields:
        return
    try:
        await channel.edit(**fields)
    except discord.RateLimited:
        fields.pop("name", None)
        if fields:
            await channel.edit(**fields)


def usable_category(guild: discord.Guild, category_id: int | None) -> discord.CategoryChannel | None:
    category = guild.get_channel(category_id) if category_id else None
    if isinstance(category, discord.CategoryChannel) and len(category.channels) < 50:
        return category
    return None


# Logs and transcripts


async def write_log(guild: discord.Guild, panel: dict, ticket: dict, title: str, actor: discord.abc.User, color: discord.Color):
    channel = guild.get_channel(panel["log_channel"]) if panel["log_channel"] else None
    if not isinstance(channel, discord.TextChannel):
        return
    embed = discord.Embed(title=title, color=color, timestamp=discord.utils.utcnow())
    embed.add_field(name="Ticket", value=f"{panel['name']} #{ticket['number']}")
    embed.add_field(name="Owner", value=f"<@{ticket['owner_id']}>")
    embed.add_field(name="By", value=actor.mention)
    try:
        await channel.send(embed=embed, allowed_mentions=discord.AllowedMentions.none())
    except DISCORD_ERRORS as error:
        log.warning("Could not write to the log channel: %s", error)


async def build_transcript(channel: discord.TextChannel, ticket: dict) -> bytes:
    messages = []
    async for message in channel.history(limit=1000):
        messages.append(
            {
                "author": message.author.display_name,
                "avatar": message.author.display_avatar.url,
                "bot": message.author.bot,
                "time": message.created_at,
                "content": message.clean_content,
                "files": [
                    {"name": file.filename, "url": file.url, "image": (file.content_type or "").startswith("image/")}
                    for file in message.attachments
                ],
                "embeds": [{"title": embed.title, "description": embed.description} for embed in message.embeds],
            }
        )
    messages.reverse()
    owner = await find_member(channel.guild, ticket["owner_id"])
    owner_name = owner.display_name if owner else str(ticket["owner_id"])
    return render_transcript(channel.name, channel.guild.name, owner_name, messages).encode()


def transcript_file(channel: discord.TextChannel, data: bytes) -> discord.File:
    return discord.File(io.BytesIO(data), filename=f"{channel.name}-transcript.html")


async def save_transcript(channel: discord.TextChannel, panel: dict, ticket: dict, data: bytes | None = None) -> bool:
    target = channel.guild.get_channel(panel["transcript_channel"]) if panel["transcript_channel"] else None
    if not isinstance(target, discord.TextChannel):
        return False
    data = data or await build_transcript(channel, ticket)
    await target.send(
        f"Transcript for **{discord.utils.escape_markdown(channel.name)}**, opened by <@{ticket['owner_id']}>",
        file=transcript_file(channel, data),
        allowed_mentions=discord.AllowedMentions.none(),
    )
    return True


async def dm_transcript(channel: discord.TextChannel, ticket: dict, data: bytes) -> None:
    owner = await find_member(channel.guild, ticket["owner_id"])
    if owner is None:
        return
    try:
        await owner.send(f"Here is the transcript of your ticket in **{channel.guild.name}**.", file=transcript_file(channel, data))
    except DISCORD_ERRORS:
        log.info("Could not DM a transcript to %s", ticket["owner_id"])


# Ticket actions


def panel_of(ticket: dict) -> dict:
    panel = db.get_panel(ticket["panel_id"])
    if panel is None:
        raise UserError("The panel for this ticket no longer exists.")
    return panel


def current_ticket(interaction: discord.Interaction) -> tuple[dict, dict]:
    ticket = db.ticket_by_channel(interaction.channel_id)
    if ticket is None:
        raise UserError("Use this inside a ticket.")
    return ticket, panel_of(ticket)


async def open_ticket(guild: discord.Guild, panel: dict, owner: discord.Member, answers: list[tuple[str, str]] | None = None) -> dict:
    try:
        ticket = db.reserve_ticket(panel, owner.id)
    except LimitReached:
        raise UserError("You already have the maximum number of open tickets here.") from None

    try:
        channel = await guild.create_text_channel(
            channel_name(panel["ticket_name"], panel, ticket["number"], owner.name),
            category=usable_category(guild, panel["open_category"]),
            overwrites=await ticket_overwrites(guild, panel, ticket, closed=False),
            reason=f"Ticket opened by {owner}",
        )
    except discord.RateLimited as error:
        db.release_ticket(ticket["id"])
        log.warning("Discord is limiting channel creation for %.0f seconds", error.retry_after)
        raise UserError(rate_limit_message(error, "creating new ticket channels")) from error
    except Exception as error:
        db.release_ticket(ticket["id"])
        log.warning("Could not create a ticket channel: %s", error)
        if isinstance(error, discord.HTTPException):
            raise UserError("I couldn't create the ticket. Check that I have Manage Channels and Manage Roles.") from error
        raise

    ticket = db.activate_ticket(ticket["id"], channel.id)
    embed = discord.Embed(description=message_text(panel["welcome_text"], panel, ticket, guild), color=BRAND_COLOR)
    pings = owner.mention
    if "{support}" in panel["welcome_text"]:
        pings = " ".join([pings, *(f"<@&{role}>" for role in panel["support_roles"])])
    await channel.send(
        content=pings,
        embed=embed,
        view=TicketView(claiming=panel["claiming"]),
        allowed_mentions=discord.AllowedMentions(users=True, roles=True, everyone=False),
    )
    if answers:
        form = discord.Embed(title="Answers", color=BRAND_COLOR)
        for question, answer in answers:
            form.add_field(name=question, value=(answer or "No answer")[:1024], inline=False)
        await channel.send(embed=form, allowed_mentions=discord.AllowedMentions.none())
    await write_log(guild, panel, ticket, "Ticket opened", owner, discord.Color.green())
    return ticket


async def close_ticket(channel: discord.TextChannel, ticket: dict, panel: dict, actor: discord.Member) -> None:
    if not panel["keep_closed"]:
        await delete_ticket(channel, ticket, panel, actor)
        return
    if not db.set_state(ticket["id"], ("open",), "closed"):
        raise UserError("This ticket is already closed.")

    fields = {"overwrites": await ticket_overwrites(channel.guild, panel, ticket, closed=True)}
    category = usable_category(channel.guild, panel["closed_category"])
    if category:
        fields["category"] = category
    try:
        await edit_ticket_channel(channel, channel_name(panel["closed_name"], panel, ticket["number"]), **fields)
    except DISCORD_ERRORS as error:
        db.set_state(ticket["id"], ("closed",), "open")
        if isinstance(error, discord.RateLimited):
            raise UserError(rate_limit_message(error, "editing this channel")) from error
        raise UserError("I couldn't close this ticket. Check my channel permissions.") from error

    control = await channel.send(
        embed=discord.Embed(description=f"Ticket closed by {actor.mention}.", color=discord.Color.orange()),
        view=ClosedView(),
        allowed_mentions=discord.AllowedMentions.none(),
    )
    db.set_control_message(ticket["id"], control.id)
    if panel["dm_transcript"]:
        await dm_transcript(channel, ticket, await build_transcript(channel, ticket))
    await write_log(channel.guild, panel, ticket, "Ticket closed", actor, discord.Color.orange())


async def reopen_ticket(channel: discord.TextChannel, ticket: dict, panel: dict, actor: discord.Member) -> None:
    if not db.set_state(ticket["id"], ("closed",), "open"):
        raise UserError("This ticket isn't closed.")
    owner = await find_member(channel.guild, ticket["owner_id"])
    fields = {"overwrites": await ticket_overwrites(channel.guild, panel, ticket, closed=False)}
    category = usable_category(channel.guild, panel["open_category"]) if panel["closed_category"] else None
    if category:
        fields["category"] = category
    name = channel_name(panel["ticket_name"], panel, ticket["number"], owner.name if owner else "user")
    try:
        await edit_ticket_channel(channel, name, **fields)
    except DISCORD_ERRORS as error:
        db.set_state(ticket["id"], ("open",), "closed")
        if isinstance(error, discord.RateLimited):
            raise UserError(rate_limit_message(error, "editing this channel")) from error
        raise UserError("I couldn't reopen this ticket. Check my channel permissions.") from error

    if ticket["control_message_id"]:
        try:
            await channel.get_partial_message(ticket["control_message_id"]).delete()
        except DISCORD_ERRORS:
            pass
        db.set_control_message(ticket["id"], None)
    await channel.send(
        embed=discord.Embed(description=f"Ticket reopened by {actor.mention}.", color=discord.Color.green()),
        allowed_mentions=discord.AllowedMentions.none(),
    )
    await write_log(channel.guild, panel, ticket, "Ticket reopened", actor, discord.Color.green())


async def delete_ticket(channel: discord.TextChannel, ticket: dict, panel: dict, actor: discord.Member) -> None:
    previous = ticket["state"]
    if not db.set_state(ticket["id"], ("open", "closed"), "deleting"):
        raise UserError("This ticket is already being deleted.")

    try:
        await channel.send(embed=discord.Embed(description="This ticket will be deleted in a few seconds.", color=discord.Color.red()))
        data = await build_transcript(channel, ticket)
        await save_transcript(channel, panel, ticket, data)
        if panel["dm_transcript"] and previous == "open":
            await dm_transcript(channel, ticket, data)
    except DISCORD_ERRORS as error:
        log.warning("Could not save the transcript for ticket %s: %s", ticket["id"], error)
    await write_log(channel.guild, panel, ticket, "Ticket deleted", actor, discord.Color.red())

    await asyncio.sleep(DELETE_DELAY_SECONDS)
    try:
        await channel.delete(reason=f"Ticket deleted by {actor}")
    except discord.NotFound:
        pass
    except DISCORD_ERRORS as error:
        db.set_state(ticket["id"], ("deleting",), previous)
        if isinstance(error, discord.RateLimited):
            raise UserError(rate_limit_message(error, "deleting channels")) from error
        raise UserError("I couldn't delete this channel. Check my permissions.") from error
    db.set_state(ticket["id"], ("deleting",), "deleted")


async def toggle_claim(channel: discord.TextChannel, ticket: dict, panel: dict, actor: discord.Member) -> str:
    if not panel["claiming"]:
        raise UserError("Claiming is turned off for this panel.")
    if ticket["state"] != "open":
        raise UserError("Only open tickets can be claimed.")
    if ticket["claimed_by"] and ticket["claimed_by"] != actor.id:
        raise UserError(f"This ticket is already claimed by <@{ticket['claimed_by']}>.")
    claiming = ticket["claimed_by"] is None
    db.set_claimed(ticket["id"], actor.id if claiming else None)
    text = f"{actor.mention} will handle this ticket." if claiming else f"{actor.mention} released this ticket."
    await channel.send(embed=discord.Embed(description=text, color=BRAND_COLOR), allowed_mentions=discord.AllowedMentions.none())
    await write_log(channel.guild, panel, ticket, "Ticket claimed" if claiming else "Ticket released", actor, BRAND_COLOR)
    return "Ticket claimed." if claiming else "Ticket released."


# Buttons and forms


async def report_error(interaction: discord.Interaction, error: Exception) -> None:
    original = getattr(error, "original", error)
    if isinstance(original, UserError):
        text = str(original)
    elif isinstance(original, discord.RateLimited):
        text = rate_limit_message(original, "doing that")
    elif isinstance(original, discord.Forbidden):
        text = "I'm missing a permission for that. Check my role and channel permissions."
    else:
        log.error("Unexpected error", exc_info=original)
        text = "Something went wrong. Please try again."
    try:
        if interaction.response.is_done():
            await interaction.followup.send(text, ephemeral=True)
        else:
            await interaction.response.send_message(text, ephemeral=True)
    except DISCORD_ERRORS:
        pass


async def reply(interaction: discord.Interaction, text: str) -> None:
    """Sends a private reply. The ticket channel may already be gone, which is fine."""
    try:
        if interaction.response.is_done():
            await interaction.followup.send(text, ephemeral=True)
        else:
            await interaction.response.send_message(text, ephemeral=True)
    except DISCORD_ERRORS:
        pass


class BaseView(discord.ui.View):
    async def on_error(self, interaction: discord.Interaction, error: Exception, item) -> None:
        await report_error(interaction, error)


class ConfirmClose(BaseView):
    def __init__(self):
        super().__init__(timeout=60)

    @discord.ui.button(label="Close ticket", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        ticket, panel = current_ticket(interaction)
        await interaction.response.edit_message(content="Closing this ticket.", view=None)
        await close_ticket(interaction.channel, ticket, panel, interaction.user)

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(content="The ticket stays open.", view=None)


class TicketView(BaseView):
    def __init__(self, claiming: bool = True):
        super().__init__(timeout=None)
        if not claiming:
            self.remove_item(self.claim_button)

    @discord.ui.button(label="Close", emoji="🔒", style=discord.ButtonStyle.secondary, custom_id="toxtickety:close")
    async def close_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        ticket, panel = current_ticket(interaction)
        if ticket["state"] != "open":
            raise UserError("This ticket is already closed.")
        if interaction.user.id != ticket["owner_id"]:
            require_support(interaction.user, panel)
        if panel["confirm_close"]:
            await interaction.response.send_message("Close this ticket?", view=ConfirmClose(), ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        await close_ticket(interaction.channel, ticket, panel, interaction.user)

    @discord.ui.button(label="Claim", emoji="🙋", style=discord.ButtonStyle.success, custom_id="toxtickety:claim")
    async def claim_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        ticket, panel = current_ticket(interaction)
        require_support(interaction.user, panel)
        await interaction.response.defer(ephemeral=True)
        await reply(interaction, await toggle_claim(interaction.channel, ticket, panel, interaction.user))


class ClosedView(BaseView):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Transcript", emoji="📑", style=discord.ButtonStyle.secondary, custom_id="toxtickety:transcript")
    async def transcript_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        ticket, panel = current_ticket(interaction)
        require_support(interaction.user, panel)
        await interaction.response.defer(ephemeral=True)
        await send_transcript(interaction, ticket, panel)

    @discord.ui.button(label="Reopen", emoji="🔓", style=discord.ButtonStyle.secondary, custom_id="toxtickety:reopen")
    async def reopen_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        ticket, panel = current_ticket(interaction)
        require_support(interaction.user, panel)
        await interaction.response.defer(ephemeral=True)
        await reopen_ticket(interaction.channel, ticket, panel, interaction.user)
        await reply(interaction, "Ticket reopened.")

    @discord.ui.button(label="Delete", emoji="⛔", style=discord.ButtonStyle.danger, custom_id="toxtickety:delete")
    async def delete_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        ticket, panel = current_ticket(interaction)
        require_support(interaction.user, panel)
        await interaction.response.defer(ephemeral=True)
        await delete_ticket(interaction.channel, ticket, panel, interaction.user)


async def send_transcript(interaction: discord.Interaction, ticket: dict, panel: dict) -> None:
    """Saves to the transcript channel, or hands the file to the person asking if none is set."""
    data = await build_transcript(interaction.channel, ticket)
    if await save_transcript(interaction.channel, panel, ticket, data):
        await reply(interaction, f"Transcript saved to <#{panel['transcript_channel']}>.")
    else:
        await interaction.followup.send(file=transcript_file(interaction.channel, data), ephemeral=True)


class QuestionForm(discord.ui.Modal):
    def __init__(self, panel: dict):
        super().__init__(title=panel["name"][:45])
        self.panel = panel
        self.inputs = []
        for question in panel["questions"][:5]:
            field = discord.ui.TextInput(
                label=question["text"][:45],
                style=discord.TextStyle.paragraph if question["long"] else discord.TextStyle.short,
                required=question["required"],
                max_length=1000,
            )
            self.inputs.append(field)
            self.add_item(field)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        answers = [(field.label, field.value) for field in self.inputs]
        ticket = await open_ticket(interaction.guild, self.panel, interaction.user, answers)
        await reply(interaction, f"Your ticket is ready: <#{ticket['channel_id']}>")

    async def on_error(self, interaction: discord.Interaction, error: Exception) -> None:
        await report_error(interaction, error)


class OpenTicketButton(discord.ui.DynamicItem[discord.ui.Button], template=r"toxtickety:open:(?P<id>\d+)"):
    """The button on a panel. It keeps working after restarts because its ID holds the panel number."""

    def __init__(self, panel_id: int, label: str = "Open ticket", emoji: str | None = None, color: str = "blue"):
        super().__init__(
            discord.ui.Button(
                label=label,
                emoji=emoji or None,
                style=BUTTON_COLORS.get(color, discord.ButtonStyle.primary),
                custom_id=f"toxtickety:open:{panel_id}",
            )
        )
        self.panel_id = panel_id

    @classmethod
    async def from_custom_id(cls, interaction: discord.Interaction, item: discord.ui.Button, match: re.Match):
        return cls(int(match["id"]))

    async def callback(self, interaction: discord.Interaction):
        try:
            panel = db.get_panel(self.panel_id)
            if panel is None or panel["guild_id"] != interaction.guild_id:
                raise UserError("This panel no longer exists.")
            if db.at_limit(panel, interaction.user.id):
                raise UserError("You already have the maximum number of open tickets here.")
            if panel["questions"]:
                await interaction.response.send_modal(QuestionForm(panel))
                return
            await interaction.response.defer(ephemeral=True)
            ticket = await open_ticket(interaction.guild, panel, interaction.user)
            await reply(interaction, f"Your ticket is ready: <#{ticket['channel_id']}>")
        except Exception as error:
            await report_error(interaction, error)


class PanelTextForm(discord.ui.Modal, title="Panel text"):
    panel_title = discord.ui.TextInput(label="Panel title", max_length=256)
    panel_text = discord.ui.TextInput(label="Panel message", style=discord.TextStyle.paragraph, max_length=4000)
    welcome_text = discord.ui.TextInput(
        label="Ticket welcome message",
        style=discord.TextStyle.paragraph,
        max_length=4000,
        placeholder="You can use {user}, {support}, {count}, {panel} and {server}",
    )

    def __init__(self, panel: dict):
        super().__init__()
        self.panel = panel
        self.panel_title.default = panel["panel_title"]
        self.panel_text.default = panel["panel_text"]
        self.welcome_text.default = panel["welcome_text"]

    async def on_submit(self, interaction: discord.Interaction):
        self.panel["panel_title"] = self.panel_title.value
        self.panel["panel_text"] = self.panel_text.value
        self.panel["welcome_text"] = self.welcome_text.value
        db.update_panel(self.panel)
        await interaction.response.send_message("Panel text saved. Send the panel again to update it.", ephemeral=True)

    async def on_error(self, interaction: discord.Interaction, error: Exception) -> None:
        await report_error(interaction, error)


# Setup commands


async def panel_choices(interaction: discord.Interaction, current: str) -> list[app_commands.Choice[str]]:
    if not interaction.permissions.manage_guild:
        return []
    panels = [panel for panel in db.list_panels(interaction.guild_id) if current.lower() in panel["name"].lower()]
    return [app_commands.Choice(name=panel["name"][:100], value=str(panel["id"])) for panel in panels[:25]]


def get_panel(interaction: discord.Interaction, value: str) -> dict:
    panel = db.find_panel(interaction.guild_id, value)
    if panel is None:
        raise UserError("I can't find that panel. Use `/panel list` to see your panels.")
    return panel


def check_name_format(value: str) -> None:
    if len(value) > 90:
        raise UserError("Channel names must be 90 characters or fewer.")
    if not re.sub(r"\{\w+\}", "", value).strip() and "{count}" not in value:
        raise UserError("Enter a channel name, for example `complaint-{count}`.")


def describe_panel(guild: discord.Guild, panel: dict) -> discord.Embed:
    mention = lambda value, symbol: f"<{symbol}{value}>" if value else "Not set"
    roles = " ".join(f"<@&{role}>" for role in panel["support_roles"]) or "Not set"
    questions = "\n".join(f"{index}. {item['text']}" for index, item in enumerate(panel["questions"], 1)) or "None"
    embed = discord.Embed(title=panel["name"], color=BRAND_COLOR)
    embed.add_field(name="Next ticket", value=f"#{channel_name(panel['ticket_name'], panel, panel['counter'] + 1)}")
    embed.add_field(name="Name format", value=f"`{panel['ticket_name']}`")
    embed.add_field(name="Closed name format", value=f"`{panel['closed_name']}`")
    embed.add_field(name="Support roles", value=roles)
    embed.add_field(name="Open category", value=mention(panel["open_category"], "#"))
    embed.add_field(name="Closed category", value=mention(panel["closed_category"], "#"))
    embed.add_field(name="Transcript channel", value=mention(panel["transcript_channel"], "#"))
    embed.add_field(name="Log channel", value=mention(panel["log_channel"], "#"))
    embed.add_field(name="Open tickets per member", value=panel["ticket_limit"] or "No limit")
    embed.add_field(
        name="Options",
        value=(
            f"Claiming: {'on' if panel['claiming'] else 'off'}\n"
            f"Confirm before closing: {'on' if panel['confirm_close'] else 'off'}\n"
            f"Keep closed tickets: {'on' if panel['keep_closed'] else 'off'}\n"
            f"DM transcript: {'on' if panel['dm_transcript'] else 'off'}"
        ),
    )
    embed.add_field(name="Questions", value=questions[:1024])
    return embed


@app_commands.default_permissions(manage_guild=True)
@app_commands.guild_only()
class PanelCommands(app_commands.Group, name="panel", description="Set up ticket panels"):
    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if not interaction.user.guild_permissions.manage_guild:
            raise UserError("You need the Manage Server permission to set up panels.")
        return True

    @app_commands.command(description="Create a ticket panel")
    @app_commands.describe(
        name="Panel name, such as Complaints",
        ticket_name="Channel name format, such as complaint-{count}",
        support_role="Role that handles these tickets",
        category="Category for new tickets",
    )
    async def create(
        self,
        interaction: discord.Interaction,
        name: app_commands.Range[str, 1, 60],
        ticket_name: Optional[str] = None,
        support_role: Optional[discord.Role] = None,
        category: Optional[discord.CategoryChannel] = None,
    ):
        if db.find_panel(interaction.guild_id, name):
            raise UserError("A panel with that name already exists.")
        settings = {}
        if ticket_name:
            check_name_format(ticket_name)
            settings["ticket_name"] = ticket_name
        if support_role:
            settings["support_roles"] = [support_role.id]
        if category:
            settings["open_category"] = category.id
        panel = db.create_panel(interaction.guild_id, name, **settings)
        await interaction.response.send_message(
            f"Panel **{discord.utils.escape_markdown(name)}** created. Use `/panel send` to post it.",
            embed=describe_panel(interaction.guild, panel),
            ephemeral=True,
        )

    @app_commands.command(description="Change a panel's settings")
    @app_commands.autocomplete(panel=panel_choices)
    @app_commands.describe(
        panel="Panel to change",
        name="New panel name",
        ticket_name="Open ticket name, such as complaint-{count}",
        closed_name="Closed ticket name, such as closed-{count}",
        number_padding="Digits in the ticket number: 4 makes 0001",
        next_number="Number the next ticket should use",
        open_category="Category for open tickets",
        closed_category="Category for closed tickets",
        transcript_channel="Channel that receives transcripts",
        log_channel="Channel that receives ticket logs",
        ticket_limit="Open tickets per member, 0 for no limit",
        claiming="Let the support team claim tickets",
        confirm_close="Ask before closing a ticket",
        keep_closed="Keep closed tickets until staff delete them",
        dm_transcript="Send the ticket owner a transcript",
        button_label="Text on the panel button",
        button_emoji="Emoji on the panel button",
        button_color="Color of the panel button",
        clear="Remove a category or channel setting",
    )
    async def edit(
        self,
        interaction: discord.Interaction,
        panel: str,
        name: Optional[app_commands.Range[str, 1, 60]] = None,
        ticket_name: Optional[str] = None,
        closed_name: Optional[str] = None,
        number_padding: Optional[app_commands.Range[int, 0, 10]] = None,
        next_number: Optional[app_commands.Range[int, 1, 1_000_000]] = None,
        open_category: Optional[discord.CategoryChannel] = None,
        closed_category: Optional[discord.CategoryChannel] = None,
        transcript_channel: Optional[discord.TextChannel] = None,
        log_channel: Optional[discord.TextChannel] = None,
        ticket_limit: Optional[app_commands.Range[int, 0, 50]] = None,
        claiming: Optional[bool] = None,
        confirm_close: Optional[bool] = None,
        keep_closed: Optional[bool] = None,
        dm_transcript: Optional[bool] = None,
        button_label: Optional[app_commands.Range[str, 1, 80]] = None,
        button_emoji: Optional[str] = None,
        button_color: Optional[ButtonColor] = None,
        clear: Optional[ClearOption] = None,
    ):
        target = get_panel(interaction, panel)
        if name and name.lower() != target["name"].lower() and db.find_panel(interaction.guild_id, name):
            raise UserError("A panel with that name already exists.")
        for value in (ticket_name, closed_name):
            if value:
                check_name_format(value)
        if button_emoji and not valid_emoji(button_emoji):
            raise UserError("Use a standard emoji or a custom server emoji.")

        changes = {
            "name": name,
            "ticket_name": ticket_name,
            "closed_name": closed_name,
            "padding": number_padding,
            "ticket_limit": ticket_limit,
            "claiming": claiming,
            "confirm_close": confirm_close,
            "keep_closed": keep_closed,
            "dm_transcript": dm_transcript,
            "button_label": button_label,
            "button_emoji": button_emoji,
            "button_color": button_color,
            "open_category": open_category.id if open_category else None,
            "closed_category": closed_category.id if closed_category else None,
            "transcript_channel": transcript_channel.id if transcript_channel else None,
            "log_channel": log_channel.id if log_channel else None,
        }
        target.update({key: value for key, value in changes.items() if value is not None})
        if clear:
            target[clear] = None
        db.update_panel(target)
        if next_number is not None:
            db.set_counter(target["id"], next_number - 1)
            target["counter"] = next_number - 1
        await interaction.response.send_message("Panel saved.", embed=describe_panel(interaction.guild, target), ephemeral=True)

    @app_commands.command(description="Edit a panel's messages")
    @app_commands.autocomplete(panel=panel_choices)
    async def text(self, interaction: discord.Interaction, panel: str):
        await interaction.response.send_modal(PanelTextForm(get_panel(interaction, panel)))

    @app_commands.command(name="add-role", description="Add a support role to a panel")
    @app_commands.autocomplete(panel=panel_choices)
    async def add_role(self, interaction: discord.Interaction, panel: str, role: discord.Role):
        target = get_panel(interaction, panel)
        if role.id not in target["support_roles"]:
            target["support_roles"].append(role.id)
            db.update_panel(target)
        await interaction.response.send_message(f"{role.mention} can now handle these tickets.", ephemeral=True)

    @app_commands.command(name="remove-role", description="Remove a support role from a panel")
    @app_commands.autocomplete(panel=panel_choices)
    async def remove_role(self, interaction: discord.Interaction, panel: str, role: discord.Role):
        target = get_panel(interaction, panel)
        if role.id in target["support_roles"]:
            target["support_roles"].remove(role.id)
            db.update_panel(target)
        await interaction.response.send_message(f"{role.mention} no longer handles new tickets.", ephemeral=True)

    @app_commands.command(name="add-question", description="Ask members a question before opening a ticket")
    @app_commands.autocomplete(panel=panel_choices)
    @app_commands.describe(question="The question to ask", long_answer="Give a larger answer box", required="Must be answered")
    async def add_question(
        self,
        interaction: discord.Interaction,
        panel: str,
        question: app_commands.Range[str, 1, 45],
        long_answer: bool = False,
        required: bool = True,
    ):
        target = get_panel(interaction, panel)
        if len(target["questions"]) >= 5:
            raise UserError("A panel can have up to 5 questions.")
        target["questions"].append({"text": question, "long": long_answer, "required": required})
        db.update_panel(target)
        await interaction.response.send_message(f"Question {len(target['questions'])} added.", ephemeral=True)

    @app_commands.command(name="clear-questions", description="Remove all of a panel's questions")
    @app_commands.autocomplete(panel=panel_choices)
    async def clear_questions(self, interaction: discord.Interaction, panel: str):
        target = get_panel(interaction, panel)
        target["questions"] = []
        db.update_panel(target)
        await interaction.response.send_message("Questions removed.", ephemeral=True)

    @app_commands.command(description="Post a panel, with up to 5 ticket types on one message")
    @app_commands.autocomplete(panel=panel_choices, panel2=panel_choices, panel3=panel_choices, panel4=panel_choices, panel5=panel_choices)
    @app_commands.describe(channel="Where to post it. Defaults to this channel")
    async def send(
        self,
        interaction: discord.Interaction,
        panel: str,
        channel: Optional[discord.TextChannel] = None,
        panel2: Optional[str] = None,
        panel3: Optional[str] = None,
        panel4: Optional[str] = None,
        panel5: Optional[str] = None,
    ):
        panels = [get_panel(interaction, value) for value in (panel, panel2, panel3, panel4, panel5) if value]
        if len({item["id"] for item in panels}) != len(panels):
            raise UserError("Choose each panel only once.")
        destination = channel or interaction.channel
        view = discord.ui.View(timeout=None)
        for item in panels:
            view.add_item(OpenTicketButton(item["id"], item["button_label"], item["button_emoji"], item["button_color"]))
        embed = discord.Embed(title=panels[0]["panel_title"], description=panels[0]["panel_text"], color=BRAND_COLOR)
        await interaction.response.defer(ephemeral=True)
        await destination.send(embed=embed, view=view, allowed_mentions=discord.AllowedMentions.none())
        await reply(interaction, f"Panel posted in {destination.mention}.")

    @app_commands.command(description="Show a panel's settings")
    @app_commands.autocomplete(panel=panel_choices)
    async def view(self, interaction: discord.Interaction, panel: str):
        embed = describe_panel(interaction.guild, get_panel(interaction, panel))
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(description="List this server's panels")
    async def list(self, interaction: discord.Interaction):
        panels = db.list_panels(interaction.guild_id)
        lines = [f"**{discord.utils.escape_markdown(item['name'])}**: {item['counter']} tickets" for item in panels]
        await interaction.response.send_message("\n".join(lines) or "No panels yet. Use `/panel create`.", ephemeral=True)

    @app_commands.command(description="Delete a panel")
    @app_commands.autocomplete(panel=panel_choices)
    async def delete(self, interaction: discord.Interaction, panel: str):
        target = get_panel(interaction, panel)
        if db.active_ticket_count(target["id"]):
            raise UserError("This panel still has tickets. Delete them first.")
        db.delete_panel(target["id"])
        await interaction.response.send_message("Panel deleted.", ephemeral=True)


# Ticket commands


class TicketClient(discord.Client):
    def __init__(self):
        intents = discord.Intents.none()
        intents.guilds = True
        intents.message_content = True  # Needed to read messages for transcripts.
        super().__init__(
            intents=intents,
            max_messages=None,
            max_ratelimit_timeout=30,
            allowed_mentions=discord.AllowedMentions(everyone=False, roles=False, users=True),
            activity=discord.Activity(type=discord.ActivityType.watching, name=os.getenv("BOT_STATUS", "your tickets")),
        )
        self.tree = app_commands.CommandTree(self)
        self.recovered = False

    async def setup_hook(self) -> None:
        if not await ratelimit_patch_works():
            log.error("The discord.py rate-limit workaround is not active. Tickets may stop opening after the first one.")
        self.add_view(TicketView())
        self.add_view(ClosedView())
        self.add_dynamic_items(OpenTicketButton)
        try:
            await self.tree.sync()
        except DISCORD_ERRORS as error:
            log.warning("Could not update slash commands: %s", error)

    async def on_ready(self) -> None:
        log.info("Logged in as %s", self.user)
        permissions = discord.Permissions(
            view_channel=True,
            send_messages=True,
            embed_links=True,
            attach_files=True,
            add_reactions=True,
            read_message_history=True,
            manage_channels=True,
            manage_roles=True,
            manage_messages=True,
        )
        log.info("Invite link: %s", discord.utils.oauth_url(self.user.id, permissions=permissions))
        if not self.recovered:
            self.recovered = True
            await self.recover()

    async def recover(self) -> None:
        """Tidies up anything left unfinished by a restart."""
        for ticket in db.tickets_in_states("creating"):
            db.drop_ticket(ticket["id"])
        for ticket in db.tickets_in_states("open", "closed", "deleting"):
            guild = self.get_guild(ticket["guild_id"])
            if guild is None:
                continue
            channel = guild.get_channel(ticket["channel_id"])
            if channel is None:
                db.set_state(ticket["id"], ("open", "closed", "deleting"), "deleted")
            elif ticket["state"] == "deleting":
                try:
                    await channel.delete(reason="Finishing a ticket deletion")
                    db.set_state(ticket["id"], ("deleting",), "deleted")
                except DISCORD_ERRORS as error:
                    log.warning("Could not finish deleting ticket %s: %s", ticket["id"], error)

    async def on_guild_channel_delete(self, channel: discord.abc.GuildChannel) -> None:
        ticket = db.ticket_by_channel(channel.id)
        if ticket:
            db.set_state(ticket["id"], ("open", "closed", "deleting"), "deleted")


client = TicketClient()
client.tree.add_command(PanelCommands())


@client.tree.error
async def on_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError) -> None:
    await report_error(interaction, error)


@client.tree.command(description="Show how to set up and use the ticket bot")
@app_commands.guild_only()
async def help(interaction: discord.Interaction):
    embed = discord.Embed(title="Ticket bot", color=BRAND_COLOR)
    embed.add_field(
        name="Set up",
        value=(
            "1. `/panel create` makes a ticket type\n"
            "2. `/panel edit` changes its settings\n"
            "3. `/panel text` changes its messages\n"
            "4. `/panel send` posts the button"
        ),
        inline=False,
    )
    embed.add_field(
        name="In a ticket",
        value=(
            "`/close` `/reopen` `/delete` `/rename`\n"
            "`/add` `/remove` `/claim` `/transcript`"
        ),
        inline=False,
    )
    embed.add_field(
        name="Channel name placeholders",
        value="`{count}` ticket number, `{user}` member name, `{panel}` panel name",
        inline=False,
    )
    await interaction.response.send_message(embed=embed, ephemeral=True)


@client.tree.command(description="Close this ticket")
@app_commands.guild_only()
async def close(interaction: discord.Interaction):
    ticket, panel = current_ticket(interaction)
    if interaction.user.id != ticket["owner_id"]:
        require_support(interaction.user, panel)
    await interaction.response.defer(ephemeral=True)
    await close_ticket(interaction.channel, ticket, panel, interaction.user)
    await reply(interaction, "Ticket closed.")


@client.tree.command(description="Reopen this ticket")
@app_commands.guild_only()
async def reopen(interaction: discord.Interaction):
    ticket, panel = current_ticket(interaction)
    require_support(interaction.user, panel)
    await interaction.response.defer(ephemeral=True)
    await reopen_ticket(interaction.channel, ticket, panel, interaction.user)
    await reply(interaction, "Ticket reopened.")


@client.tree.command(description="Delete this ticket")
@app_commands.guild_only()
async def delete(interaction: discord.Interaction):
    ticket, panel = current_ticket(interaction)
    require_support(interaction.user, panel)
    await interaction.response.defer(ephemeral=True)
    await delete_ticket(interaction.channel, ticket, panel, interaction.user)


@client.tree.command(description="Rename this ticket")
@app_commands.guild_only()
@app_commands.describe(name="New channel name")
async def rename(interaction: discord.Interaction, name: app_commands.Range[str, 1, 90]):
    ticket, panel = current_ticket(interaction)
    require_support(interaction.user, panel)
    await interaction.response.defer(ephemeral=True)
    new_name = channel_name(name, panel, ticket["number"])
    if not renames.allow(interaction.channel_id):
        raise UserError("Discord allows 2 renames every 10 minutes. Try again later.")
    try:
        await interaction.channel.edit(name=new_name)
    except discord.RateLimited:
        raise UserError("Discord allows 2 renames every 10 minutes. Try again later.") from None
    await reply(interaction, f"Renamed to **{new_name}**.")


@client.tree.command(description="Give a member access to this ticket")
@app_commands.guild_only()
async def add(interaction: discord.Interaction, member: discord.Member):
    ticket, panel = current_ticket(interaction)
    require_support(interaction.user, panel)
    if ticket["state"] != "open":
        raise UserError("Reopen this ticket first.")
    if member.id == ticket["owner_id"] or member.id in ticket["added_users"]:
        raise UserError("They already have access.")
    await interaction.response.defer(ephemeral=True)
    ticket["added_users"].append(member.id)
    try:
        await edit_ticket_channel(interaction.channel, overwrites=await ticket_overwrites(interaction.guild, panel, ticket, closed=False))
    except discord.RateLimited as error:
        raise UserError(rate_limit_message(error, "editing this channel")) from error
    db.set_added(ticket["id"], ticket["added_users"])
    await reply(interaction, f"Added {member.mention}.")


@client.tree.command(description="Remove a member from this ticket")
@app_commands.guild_only()
async def remove(interaction: discord.Interaction, member: discord.Member):
    ticket, panel = current_ticket(interaction)
    require_support(interaction.user, panel)
    if member.id == ticket["owner_id"]:
        raise UserError("You can't remove the ticket owner.")
    if member.id not in ticket["added_users"]:
        raise UserError("They weren't added to this ticket.")
    await interaction.response.defer(ephemeral=True)
    ticket["added_users"].remove(member.id)
    try:
        await edit_ticket_channel(
            interaction.channel,
            overwrites=await ticket_overwrites(interaction.guild, panel, ticket, closed=ticket["state"] == "closed"),
        )
    except discord.RateLimited as error:
        raise UserError(rate_limit_message(error, "editing this channel")) from error
    db.set_added(ticket["id"], ticket["added_users"])
    await reply(interaction, f"Removed {member.mention}.")


@client.tree.command(description="Claim this ticket, or release your claim")
@app_commands.guild_only()
async def claim(interaction: discord.Interaction):
    ticket, panel = current_ticket(interaction)
    require_support(interaction.user, panel)
    await interaction.response.defer(ephemeral=True)
    await reply(interaction, await toggle_claim(interaction.channel, ticket, panel, interaction.user))


@client.tree.command(description="Save a transcript of this ticket")
@app_commands.guild_only()
async def transcript(interaction: discord.Interaction):
    ticket, panel = current_ticket(interaction)
    require_support(interaction.user, panel)
    await interaction.response.defer(ephemeral=True)
    await send_transcript(interaction, ticket, panel)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    token = os.getenv("DISCORD_TOKEN")
    if not token:
        raise SystemExit("Add your bot token to the .env file as DISCORD_TOKEN=...")
    try:
        client.run(token, log_handler=None)
    except discord.PrivilegedIntentsRequired:
        raise SystemExit("Turn on Message Content Intent on your bot's page in the Discord Developer Portal.") from None
    except discord.LoginFailure:
        raise SystemExit("Discord rejected the token. Copy it again from the Developer Portal.") from None


if __name__ == "__main__":
    main()
