import asyncio
import os
import sys
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_PATH"] = ":memory:"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import discord  # noqa: E402

import bot  # noqa: E402
from database import Database, LimitReached  # noqa: E402
from transcript import render_transcript  # noqa: E402

GUILD_ID = 100000000000000001
SUPPORT_ROLE = 100000000000000002


class Thing(SimpleNamespace):
    __hash__ = object.__hash__


def permissions(manage_guild=False):
    return discord.Permissions(manage_guild=manage_guild)


def member(user_id, name="alice", roles=(), admin=False):
    return Thing(
        id=user_id,
        name=name,
        display_name=name,
        mention=f"<@{user_id}>",
        roles=[SimpleNamespace(id=role) for role in roles],
        guild_permissions=permissions(admin),
        send=AsyncMock(),
    )


class FakeChannel:
    def __init__(self, guild, name, category=None):
        self.id = 900000000000000000 + len(guild.channels)
        self.guild = guild
        self.name = name
        self.category = category
        self.overwrites = None
        self.sent = []
        self.deleted = False
        self.fail_edit = None
        guild.channels[self.id] = self

    async def send(self, content=None, **kwargs):
        view = kwargs.get("view")
        if view is not None:
            view.to_components()
        message = SimpleNamespace(id=len(self.sent) + 1, content=content, **kwargs)
        self.sent.append(message)
        return message

    async def edit(self, **fields):
        if self.fail_edit:
            raise self.fail_edit
        self.name = fields.get("name", self.name)
        self.category = fields.get("category", self.category)
        self.overwrites = fields.get("overwrites", self.overwrites)

    async def delete(self, reason=None):
        self.deleted = True

    def get_partial_message(self, message_id):
        return SimpleNamespace(delete=AsyncMock())

    def history(self, limit=None):
        async def items():
            for text in ["newest", "oldest"]:
                yield SimpleNamespace(
                    author=SimpleNamespace(display_name="alice", display_avatar=SimpleNamespace(url="https://cdn.discordapp.com/a.png"), bot=False),
                    created_at=datetime.now(timezone.utc),
                    clean_content=text,
                    attachments=[],
                    embeds=[],
                )
        return items()


class FakeGuild:
    def __init__(self):
        self.id = GUILD_ID
        self.name = "Test server"
        self.channels = {}
        self.members = {}
        self.default_role = Thing(id=GUILD_ID)
        self.me = Thing(id=1, guild_permissions=discord.Permissions.all())
        self.support_role = Thing(id=SUPPORT_ROLE)
        self.create_error = None

    def get_role(self, role_id):
        return self.support_role if role_id == SUPPORT_ROLE else None

    def get_member(self, user_id):
        return self.members.get(user_id)

    async def fetch_member(self, user_id):
        raise discord.NotFound(SimpleNamespace(status=404, reason="Not Found"), "Unknown Member")

    def get_channel(self, channel_id):
        return self.channels.get(channel_id)

    async def create_text_channel(self, name, category=None, overwrites=None, reason=None):
        if self.create_error:
            raise self.create_error
        channel = FakeChannel(self, name, category)
        channel.overwrites = overwrites
        return channel


class Base(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        bot.db = Database(":memory:")
        bot.renames = bot.RenameGuard()
        bot.DELETE_DELAY_SECONDS = 0
        self.guild = FakeGuild()
        self.owner = member(11, "alice")
        self.staff = member(12, "bob", roles=[SUPPORT_ROLE])
        self.guild.members = {11: self.owner, 12: self.staff}
        self.panel = bot.db.create_panel(GUILD_ID, "Complaints", ticket_name="complaint-{count}", support_roles=[SUPPORT_ROLE])

    def channel(self, ticket):
        return self.guild.channels[ticket["channel_id"]]

    def fresh(self, ticket):
        return bot.db.get_ticket(ticket["id"])


class NamingTests(unittest.TestCase):
    panel = {"padding": 4, "name": "Complaints"}

    def test_custom_name(self):
        self.assertEqual(bot.channel_name("complaint-{count}", self.panel, 1), "complaint-0001")

    def test_cleans_invalid_characters(self):
        self.assertEqual(bot.channel_name("My Big_Ticket!! {count}", self.panel, 7), "my-big-ticket-0007")

    def test_falls_back_when_empty(self):
        self.assertEqual(bot.channel_name("!!!", self.panel, 3), "ticket-3")

    def test_member_text_is_not_expanded_twice(self):
        self.assertEqual(bot.fill("{user}", user="{count}", count="1"), "{count}")

    def test_rename_guard(self):
        guard = bot.RenameGuard()
        self.assertTrue(guard.allow(1, 0))
        self.assertTrue(guard.allow(1, 1))
        self.assertFalse(guard.allow(1, 2))
        self.assertTrue(guard.allow(1, 601))


class DatabaseTests(unittest.TestCase):
    def test_limit_and_numbering(self):
        db = Database(":memory:")
        panel = db.create_panel(GUILD_ID, "Help")
        first = db.reserve_ticket(panel, 1)
        self.assertEqual(first["number"], 1)
        with self.assertRaises(LimitReached):
            db.reserve_ticket(panel, 1)
        self.assertEqual(db.reserve_ticket(panel, 2)["number"], 2)

    def test_state_changes_only_once(self):
        db = Database(":memory:")
        ticket = db.reserve_ticket(db.create_panel(GUILD_ID, "Help"), 1)
        db.activate_ticket(ticket["id"], 5)
        self.assertTrue(db.set_state(ticket["id"], ("open",), "closed"))
        self.assertFalse(db.set_state(ticket["id"], ("open",), "closed"))

    def test_old_english_defaults_become_portuguese(self):
        db = Database(":memory:")
        panel = db.create_panel(GUILD_ID, "Help", button_label="Open ticket", panel_title="My own title")
        saved = db.get_panel(panel["id"])
        self.assertEqual(saved["button_label"], "Abrir ticket")
        self.assertEqual(saved["panel_title"], "My own title")

    def test_settings_survive_saving(self):
        db = Database(":memory:")
        panel = db.create_panel(GUILD_ID, "Help")
        panel["ticket_name"] = "bug-{count}"
        panel["questions"] = [{"text": "Why?", "long": True, "required": False}]
        db.update_panel(panel)
        saved = db.find_panel(GUILD_ID, "help")
        self.assertEqual(saved["ticket_name"], "bug-{count}")
        self.assertEqual(saved["questions"][0]["text"], "Why?")


class LifecycleTests(Base):
    async def test_open_creates_private_named_channel(self):
        ticket = await bot.open_ticket(self.guild, self.panel, self.owner)
        channel = self.channel(ticket)
        self.assertEqual(channel.name, "complaint-0001")
        self.assertFalse(channel.overwrites[self.guild.default_role].view_channel)
        self.assertTrue(channel.overwrites[self.owner].send_messages)
        self.assertTrue(channel.overwrites[self.guild.support_role].view_channel)

    async def test_support_is_pinged_only_when_asked(self):
        ticket = await bot.open_ticket(self.guild, self.panel, self.owner)
        self.assertNotIn(str(SUPPORT_ROLE), self.channel(ticket).sent[0].content)
        self.panel["welcome_text"] = "{support} please help {user}"
        self.panel["ticket_limit"] = 0
        ticket = await bot.open_ticket(self.guild, self.panel, self.owner)
        self.assertIn(f"<@&{SUPPORT_ROLE}>", self.channel(ticket).sent[0].content)

    async def test_limit_blocks_second_ticket(self):
        await bot.open_ticket(self.guild, self.panel, self.owner)
        with self.assertRaises(bot.UserError):
            await bot.open_ticket(self.guild, self.panel, self.owner)

    async def test_failed_creation_frees_the_slot(self):
        response = SimpleNamespace(status=403, reason="Forbidden")
        self.guild.create_error = discord.Forbidden(response, "Missing Permissions")
        with self.assertRaises(bot.UserError):
            await bot.open_ticket(self.guild, self.panel, self.owner)
        self.guild.create_error = None
        await bot.open_ticket(self.guild, self.panel, self.owner)

    async def test_rate_limit_frees_the_slot_and_number(self):
        self.guild.create_error = discord.RateLimited(85864)
        with self.assertRaises(bot.UserError) as caught:
            await bot.open_ticket(self.guild, self.panel, self.owner)
        self.assertIn("24 horas", str(caught.exception))
        self.assertEqual(bot.db.get_panel(self.panel["id"])["counter"], 0)
        self.guild.create_error = None
        ticket = await bot.open_ticket(self.guild, self.panel, self.owner)
        self.assertEqual(self.channel(ticket).name, "complaint-0001")

    async def test_rate_limited_delete_rolls_back(self):
        ticket = await bot.open_ticket(self.guild, self.panel, self.owner)
        channel = self.channel(ticket)

        async def limited(reason=None):
            raise discord.RateLimited(600)

        channel.delete = limited
        with self.assertRaises(bot.UserError):
            await bot.delete_ticket(channel, ticket, self.panel, self.staff)
        self.assertEqual(self.fresh(ticket)["state"], "open")

    async def test_close_reopen_delete(self):
        ticket = await bot.open_ticket(self.guild, self.panel, self.owner)
        channel = self.channel(ticket)

        await bot.close_ticket(channel, ticket, self.panel, self.staff)
        closed = self.fresh(ticket)
        self.assertEqual(closed["state"], "closed")
        self.assertEqual(channel.name, "fechado-0001")
        self.assertFalse(channel.overwrites[self.owner].view_channel)
        with self.assertRaises(bot.UserError):
            await bot.close_ticket(channel, closed, self.panel, self.staff)

        await bot.reopen_ticket(channel, closed, self.panel, self.staff)
        opened = self.fresh(ticket)
        self.assertEqual(opened["state"], "open")
        self.assertEqual(channel.name, "complaint-0001")
        self.assertTrue(channel.overwrites[self.owner].view_channel)

        await bot.delete_ticket(channel, opened, self.panel, self.staff)
        self.assertEqual(self.fresh(ticket)["state"], "deleted")
        self.assertTrue(channel.deleted)

    async def test_close_rolls_back_on_failure(self):
        ticket = await bot.open_ticket(self.guild, self.panel, self.owner)
        channel = self.channel(ticket)
        channel.fail_edit = discord.Forbidden(SimpleNamespace(status=403, reason="Forbidden"), "Missing Permissions")
        with self.assertRaises(bot.UserError):
            await bot.close_ticket(channel, ticket, self.panel, self.staff)
        self.assertEqual(self.fresh(ticket)["state"], "open")

    async def test_rate_limited_rename_still_closes(self):
        ticket = await bot.open_ticket(self.guild, self.panel, self.owner)
        channel = self.channel(ticket)
        real_edit = channel.edit
        calls = []

        async def limited(**fields):
            calls.append(fields)
            if "name" in fields:
                raise discord.RateLimited(500)
            await real_edit(**fields)

        channel.edit = limited
        await bot.close_ticket(channel, ticket, self.panel, self.staff)
        self.assertEqual(self.fresh(ticket)["state"], "closed")
        self.assertEqual(len(calls), 2)
        self.assertFalse(channel.overwrites[self.owner].view_channel)

    async def test_closing_deletes_when_not_keeping(self):
        self.panel["keep_closed"] = False
        ticket = await bot.open_ticket(self.guild, self.panel, self.owner)
        await bot.close_ticket(self.channel(ticket), ticket, self.panel, self.staff)
        self.assertEqual(self.fresh(ticket)["state"], "deleted")

    async def test_transcript_saved_on_delete_in_order(self):
        target = FakeChannel(self.guild, "transcripts")
        self.panel["transcript_channel"] = target.id
        ticket = await bot.open_ticket(self.guild, self.panel, self.owner)
        with patch.object(discord, "TextChannel", FakeChannel):
            await bot.delete_ticket(self.channel(ticket), ticket, self.panel, self.staff)
        data = target.sent[0].file.fp.read().decode()
        self.assertLess(data.index("oldest"), data.index("newest"))

    async def test_claiming(self):
        ticket = await bot.open_ticket(self.guild, self.panel, self.owner)
        channel = self.channel(ticket)
        await bot.toggle_claim(channel, ticket, self.panel, self.staff)
        claimed = self.fresh(ticket)
        self.assertEqual(claimed["claimed_by"], self.staff.id)
        with self.assertRaises(bot.UserError):
            await bot.toggle_claim(channel, claimed, self.panel, member(13, "carol", roles=[SUPPORT_ROLE]))
        await bot.toggle_claim(channel, claimed, self.panel, self.staff)
        self.assertIsNone(self.fresh(ticket)["claimed_by"])

    async def test_form_answers_cannot_ping(self):
        ticket = await bot.open_ticket(self.guild, self.panel, self.owner, [("What happened?", "@everyone")])
        answers = self.channel(ticket).sent[1]
        self.assertFalse(answers.allowed_mentions.everyone)
        self.assertFalse(answers.allowed_mentions.roles)

    async def test_removed_owner_does_not_break_closing(self):
        ticket = await bot.open_ticket(self.guild, self.panel, self.owner)
        del self.guild.members[self.owner.id]
        await bot.close_ticket(self.channel(ticket), ticket, self.panel, self.staff)
        self.assertEqual(self.fresh(ticket)["state"], "closed")


class RateLimitPatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_far_reset_with_requests_left_is_allowed(self):
        from discord.http import Ratelimit

        bucket = Ratelimit(30.0)
        bucket.limit, bucket.remaining = 5, 2
        bucket.expires = asyncio.get_running_loop().time() + 86000
        await bucket.acquire()
        await bucket.acquire()
        self.assertEqual(bucket.remaining, 0)

    async def test_real_limit_still_fails_fast(self):
        from discord.http import Ratelimit

        bucket = Ratelimit(30.0)
        bucket.limit, bucket.remaining = 5, 0
        bucket.expires = asyncio.get_running_loop().time() + 86000
        with self.assertRaises(discord.RateLimited):
            await bucket.acquire()

    async def test_self_check_passes(self):
        self.assertTrue(await bot.ratelimit_patch_works())


class AccessTests(unittest.TestCase):
    def test_support_rules(self):
        panel = {"support_roles": [SUPPORT_ROLE]}
        self.assertTrue(bot.is_support(member(1, roles=[SUPPORT_ROLE]), panel))
        self.assertTrue(bot.is_support(member(1, admin=True), panel))
        self.assertFalse(bot.is_support(member(1), panel))


class CommandTests(unittest.TestCase):
    def test_slash_commands_are_valid(self):
        commands = [command.to_dict(bot.client.tree) for command in bot.client.tree.get_commands()]
        names = {command["name"] for command in commands}
        self.assertEqual(names, {"panel", "teams", "help", "close", "reopen", "delete", "rename", "add", "remove", "claim", "transcript"})
        panel = next(command for command in commands if command["name"] == "panel")
        self.assertEqual(int(panel["default_member_permissions"]), discord.Permissions(manage_guild=True).value)
        for sub in panel["options"]:
            self.assertLessEqual(len(sub.get("options", [])), 25)
            required_done = False
            for option in sub.get("options", []):
                if not option.get("required"):
                    required_done = True
                self.assertFalse(required_done and option.get("required"), f"{sub['name']}: {option['name']}")
                self.assertLessEqual(len(option["description"]), 100)

    def test_panel_button_survives_restart(self):
        button = bot.OpenTicketButton(7, "Open", "📩", "green")
        self.assertRegex(button.item.custom_id, r"toxtickety:open:7$")

    def test_emoji_validation(self):
        self.assertTrue(bot.valid_emoji("📩"))
        self.assertTrue(bot.valid_emoji("<:wave:123456789012345678>"))
        self.assertFalse(bot.valid_emoji("hello"))


class TranscriptTests(unittest.TestCase):
    def test_message_content_cannot_become_markup(self):
        html = render_transcript(
            "<b>chan</b>",
            "<script>server</script>",
            "owner",
            [
                {
                    "author": '"><script>alert(1)</script>',
                    "avatar": "javascript:alert(1)",
                    "time": datetime.now(timezone.utc),
                    "content": "<img src=x onerror=alert(1)>",
                    "files": [{"name": "<svg onload=alert(1)>", "url": "javascript:alert(1)", "image": True}],
                    "embeds": [{"title": "<i>", "description": "<script>x</script>"}],
                }
            ],
        )
        body = html[html.index("<body>"):]
        self.assertNotIn("<script", body)
        self.assertNotIn("<img src=x", body)
        self.assertNotIn("javascript:", body)
        self.assertIn("default-src 'none'", html)


if __name__ == "__main__":
    unittest.main()
