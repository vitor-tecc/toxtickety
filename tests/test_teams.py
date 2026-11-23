import os
import sys
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

os.environ["DATABASE_PATH"] = ":memory:"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import discord  # noqa: E402

import teams  # noqa: E402
from database import Database  # noqa: E402

GUILD_ID = 100000000000000001
FORUM_ID = 1574395812270702723
OWNER_ID = 200000000000000001
OTHER_ID = 200000000000000002
BOT_ID = 1


def http_error(code: int, status: int = 400) -> discord.HTTPException:
    error = discord.HTTPException(SimpleNamespace(status=status, reason="Bad"), {"code": code, "message": "x"})
    return error


class FakeHTTP:
    def __init__(self):
        self.calls = []

    async def add_role(self, guild_id, user_id, role_id, reason=None):
        self.calls.append(("add", user_id, role_id))

    async def remove_role(self, guild_id, user_id, role_id, reason=None):
        self.calls.append(("remove", user_id, role_id))

    async def delete_role(self, guild_id, role_id, reason=None):
        self.calls.append(("delete", role_id))


class FakeMessage:
    def __init__(self, channel, author_id, content, message_id=None):
        self.id = message_id or 900 + len(channel.sent)
        self.channel = channel
        self.guild = channel.guild
        self.author = SimpleNamespace(id=author_id, bot=False, __str__=lambda self: "member")
        self.content = content
        self.replies = []
        self.reactions_added = []

    async def reply(self, text, **kwargs):
        self.replies.append(text)

    async def add_reaction(self, emoji):
        self.reactions_added.append(emoji)


class FakeThread:
    def __init__(self, guild, thread_id=300000000000000001, owner_id=OWNER_ID):
        self.id = thread_id
        self.guild = guild
        self.owner_id = owner_id
        self.parent_id = FORUM_ID
        self.created_at = datetime.now(timezone.utc)
        self.sent = []
        self.joined = False
        self.fail_first = None

    async def join(self):
        self.joined = True

    async def send(self, content=None, **kwargs):
        if self.fail_first:
            error, self.fail_first = self.fail_first, None
            raise error
        message = FakeMessage(self, BOT_ID, content, message_id=800 + len(self.sent))
        self.sent.append(message)
        return message


class FakeGuild:
    def __init__(self):
        self.id = GUILD_ID
        self.roles = []
        self.role_error = None

    def get_member(self, user_id):
        return None

    async def create_role(self, **kwargs):
        if self.role_error:
            raise self.role_error
        role = SimpleNamespace(id=700 + len(self.roles), mention=f"<@&{700 + len(self.roles)}>", **kwargs)
        self.roles.append(role)
        return role


class ParseTests(unittest.TestCase):
    def test_name_then_color(self):
        name, colour = teams.parse_team("Os Brabos #FF5733")
        self.assertEqual(name, "Os Brabos")
        self.assertEqual(colour.value, 0xFF5733)

    def test_color_first_and_without_hash(self):
        name, colour = teams.parse_team("ff5733 - Os Brabos")
        self.assertEqual((name, colour.value), ("Os Brabos", 0xFF5733))

    def test_short_color_needs_hash(self):
        self.assertEqual(teams.parse_team("Time #0af")[1].value, 0x00AAFF)
        self.assertIsNone(teams.parse_team("Time abc"))

    def test_word_that_looks_like_hex_is_kept_in_the_name(self):
        name, colour = teams.parse_team("Decade Team #123456")
        self.assertEqual((name, colour.value), ("Decade Team", 0x123456))

    def test_needs_both_parts(self):
        self.assertIsNone(teams.parse_team("Os Brabos"))
        self.assertIsNone(teams.parse_team("#FF5733"))

    def test_black_stays_visible(self):
        self.assertEqual(teams.parse_team("Sombra #000000")[1].value, 0x010101)


class FlowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = Database(":memory:")
        self.db.set_team_forum(GUILD_ID, FORUM_ID, 0)
        self.guild = FakeGuild()
        self.thread = FakeThread(self.guild)
        self.http = FakeHTTP()
        self.client = SimpleNamespace(http=self.http, user=SimpleNamespace(id=BOT_ID), get_guild=lambda _: self.guild)
        teams.STARTER_WAIT_SECONDS = 0

    async def started(self):
        await teams.start_team(self.db, self.thread)
        return self.db.get_team(self.thread.id)

    async def finished(self):
        await self.started()
        await teams.handle_message(self.client, self.db, FakeMessage(self.thread, OWNER_ID, "Os Brabos #FF5733"))
        return self.db.get_team(self.thread.id)

    def reaction(self, user_id, emoji=teams.REACTION, message_id=None):
        team = self.db.get_team(self.thread.id)
        return SimpleNamespace(
            guild_id=GUILD_ID,
            user_id=user_id,
            message_id=message_id or team["message_id"],
            emoji=emoji,
            member=None,
        )

    async def test_new_post_gets_the_question_once(self):
        team = await self.started()
        self.assertEqual(team["state"], "waiting")
        self.assertIn(f"<@{OWNER_ID}>", self.thread.sent[0].content)
        await teams.start_team(self.db, self.thread)
        self.assertEqual(len(self.thread.sent), 1)

    async def test_waits_for_the_first_message_of_a_post(self):
        self.thread.fail_first = http_error(40058)
        await self.started()
        self.assertEqual(len(self.thread.sent), 1)

    async def test_only_the_post_owner_answers(self):
        await self.started()
        await teams.handle_message(self.client, self.db, FakeMessage(self.thread, OTHER_ID, "Outro #123456"))
        self.assertEqual(self.guild.roles, [])

    async def test_bad_answer_gets_help(self):
        await self.started()
        message = FakeMessage(self.thread, OWNER_ID, "Os Brabos")
        await teams.handle_message(self.client, self.db, message)
        self.assertEqual(message.replies, [teams.NOT_UNDERSTOOD])
        self.assertEqual(self.db.get_team(self.thread.id)["state"], "waiting")

    async def test_creates_role_and_reaction_message_then_goes_quiet(self):
        team = await self.finished()
        role = self.guild.roles[0]
        self.assertEqual((role.name, role.colour.value), ("Os Brabos", 0xFF5733))
        self.assertEqual(role.permissions, discord.Permissions.none())
        self.assertEqual(team["state"], "done")
        notice = self.thread.sent[-1]
        self.assertIn("Clique na reação", notice.content)
        self.assertEqual(notice.reactions_added, [teams.REACTION])
        sent = len(self.thread.sent)
        later = FakeMessage(self.thread, OWNER_ID, "Outro nome #000000")
        await teams.handle_message(self.client, self.db, later)
        self.assertEqual((len(self.thread.sent), later.replies, len(self.guild.roles)), (sent, [], 1))

    async def test_role_limit_is_explained(self):
        await self.started()
        self.guild.role_error = http_error(30005)
        message = FakeMessage(self.thread, OWNER_ID, "Os Brabos #FF5733")
        await teams.handle_message(self.client, self.db, message)
        self.assertEqual(message.replies, [teams.ROLE_LIMIT])
        self.assertEqual(self.db.get_team(self.thread.id)["state"], "waiting")

    async def test_reacting_adds_and_removing_takes_away(self):
        team = await self.finished()
        await teams.handle_reaction(self.client, self.db, self.reaction(OTHER_ID), added=True)
        await teams.handle_reaction(self.client, self.db, self.reaction(OTHER_ID), added=False)
        self.assertEqual(self.http.calls, [("add", OTHER_ID, team["role_id"]), ("remove", OTHER_ID, team["role_id"])])

    async def test_other_reactions_are_ignored(self):
        await self.finished()
        await teams.handle_reaction(self.client, self.db, self.reaction(OTHER_ID, emoji="😀"), added=True)
        await teams.handle_reaction(self.client, self.db, self.reaction(BOT_ID), added=True)
        await teams.handle_reaction(self.client, self.db, self.reaction(OTHER_ID, message_id=1), added=True)
        self.assertEqual(self.http.calls, [])

    async def test_deleting_the_post_deletes_the_role(self):
        team = await self.finished()
        await teams.handle_thread_deleted(self.client, self.db, GUILD_ID, self.thread.id)
        self.assertEqual(self.http.calls, [("delete", team["role_id"])])
        self.assertIsNone(self.db.get_team(self.thread.id))

    async def test_forum_setting_can_be_changed_and_turned_off(self):
        self.db.set_team_forum(GUILD_ID, 42, 5)
        self.assertEqual(self.db.team_forum(GUILD_ID)["forum_id"], 42)
        self.db.set_team_forum(GUILD_ID, None, 6)
        self.assertIsNone(self.db.team_forum(GUILD_ID))


if __name__ == "__main__":
    unittest.main()
