"""SQLite storage for panels and tickets."""

from __future__ import annotations

import json
import os
import sqlite3
import time

DEFAULT_SETTINGS = {
    "ticket_name": "ticket-{count}",
    "closed_name": "fechado-{count}",
    "padding": 4,
    "support_roles": [],
    "open_category": None,
    "closed_category": None,
    "transcript_channel": None,
    "log_channel": None,
    "ticket_limit": 1,
    "claiming": True,
    "confirm_close": True,
    "keep_closed": True,
    "dm_transcript": False,
    "button_label": "Abrir ticket",
    "button_emoji": "📩",
    "button_color": "blue",
    "panel_title": "Abrir um ticket",
    "panel_text": "Clique no botão abaixo e nossa equipe vai te ajudar.",
    "welcome_text": "{user} Obrigado por entrar em contato! Nossa equipe vai te atender em breve.",
    "questions": [],
}


# Earlier English defaults. Panels that still use them switch to the Portuguese ones above,
# while anything a moderator wrote stays as written.
OLD_DEFAULTS = {
    "closed_name": "closed-{count}",
    "button_label": "Open ticket",
    "panel_title": "Open a ticket",
    "panel_text": "Press the button below and our team will help you.",
    "welcome_text": "{user} Thanks for reaching out. Our team will be with you shortly.",
}


class LimitReached(Exception):
    """The member already has the maximum number of open tickets."""


class Database:
    def __init__(self, path: str):
        if path != ":memory:":
            folder = os.path.dirname(path)
            if folder:
                os.makedirs(folder, exist_ok=True)
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS panels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                counter INTEGER NOT NULL DEFAULT 0,
                settings TEXT NOT NULL DEFAULT '{}',
                UNIQUE (guild_id, name)
            );
            CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id INTEGER NOT NULL,
                panel_id INTEGER NOT NULL,
                channel_id INTEGER UNIQUE,
                owner_id INTEGER NOT NULL,
                number INTEGER NOT NULL,
                state TEXT NOT NULL,
                claimed_by INTEGER,
                added_users TEXT NOT NULL DEFAULT '[]',
                control_message_id INTEGER,
                created_at INTEGER NOT NULL,
                closed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS tickets_owner ON tickets (panel_id, owner_id, state);
            CREATE TABLE IF NOT EXISTS team_forums (
                guild_id INTEGER PRIMARY KEY,
                forum_id INTEGER NOT NULL,
                since INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS teams (
                thread_id INTEGER PRIMARY KEY,
                guild_id INTEGER NOT NULL,
                owner_id INTEGER NOT NULL,
                state TEXT NOT NULL,
                role_id INTEGER,
                message_id INTEGER UNIQUE
            );
            """
        )
        columns = {row["name"] for row in self.conn.execute("PRAGMA table_info(team_forums)")}
        if "above_role_id" not in columns:
            self.conn.execute("ALTER TABLE team_forums ADD COLUMN above_role_id INTEGER")
        self.conn.commit()

    # Panels

    @staticmethod
    def _panel(row: sqlite3.Row | None) -> dict | None:
        if row is None:
            return None
        settings = {**DEFAULT_SETTINGS, **json.loads(row["settings"])}
        for key, old in OLD_DEFAULTS.items():
            if settings[key] == old:
                settings[key] = DEFAULT_SETTINGS[key]
        return {**settings, "id": row["id"], "guild_id": row["guild_id"], "name": row["name"], "counter": row["counter"]}

    def create_panel(self, guild_id: int, name: str, **settings) -> dict:
        with self.conn:
            cursor = self.conn.execute(
                "INSERT INTO panels (guild_id, name, settings) VALUES (?, ?, ?)",
                (guild_id, name, json.dumps(settings)),
            )
        return self.get_panel(cursor.lastrowid)

    def get_panel(self, panel_id: int) -> dict | None:
        return self._panel(self.conn.execute("SELECT * FROM panels WHERE id = ?", (panel_id,)).fetchone())

    def find_panel(self, guild_id: int, value: str) -> dict | None:
        """Finds a panel from an autocomplete ID or a typed name."""
        row = None
        if value.isdigit():
            row = self.conn.execute("SELECT * FROM panels WHERE guild_id = ? AND id = ?", (guild_id, int(value))).fetchone()
        if row is None:
            row = self.conn.execute(
                "SELECT * FROM panels WHERE guild_id = ? AND name = ? COLLATE NOCASE", (guild_id, value)
            ).fetchone()
        return self._panel(row)

    def list_panels(self, guild_id: int) -> list[dict]:
        rows = self.conn.execute("SELECT * FROM panels WHERE guild_id = ? ORDER BY id", (guild_id,)).fetchall()
        return [self._panel(row) for row in rows]

    def update_panel(self, panel: dict) -> None:
        settings = {key: panel[key] for key in DEFAULT_SETTINGS}
        with self.conn:
            self.conn.execute(
                "UPDATE panels SET name = ?, settings = ? WHERE id = ?",
                (panel["name"], json.dumps(settings), panel["id"]),
            )

    def set_counter(self, panel_id: int, counter: int) -> None:
        with self.conn:
            self.conn.execute("UPDATE panels SET counter = ? WHERE id = ?", (counter, panel_id))

    def delete_panel(self, panel_id: int) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM panels WHERE id = ?", (panel_id,))

    def active_ticket_count(self, panel_id: int) -> int:
        row = self.conn.execute(
            "SELECT COUNT(*) FROM tickets WHERE panel_id = ? AND state IN ('creating', 'open', 'closed', 'deleting')",
            (panel_id,),
        ).fetchone()
        return row[0]

    # Tickets

    @staticmethod
    def _ticket(row: sqlite3.Row | None) -> dict | None:
        if row is None:
            return None
        ticket = dict(row)
        ticket["added_users"] = json.loads(ticket["added_users"])
        return ticket

    def at_limit(self, panel: dict, owner_id: int) -> bool:
        if panel["ticket_limit"] <= 0:
            return False
        row = self.conn.execute(
            "SELECT COUNT(*) FROM tickets WHERE panel_id = ? AND owner_id = ? AND state IN ('creating', 'open')",
            (panel["id"], owner_id),
        ).fetchone()
        return row[0] >= panel["ticket_limit"]

    def reserve_ticket(self, panel: dict, owner_id: int) -> dict:
        """Checks the limit and takes the next number in one step, so double clicks cannot get past it."""
        with self.conn:
            if self.at_limit(panel, owner_id):
                raise LimitReached
            self.conn.execute("UPDATE panels SET counter = counter + 1 WHERE id = ?", (panel["id"],))
            number = self.conn.execute("SELECT counter FROM panels WHERE id = ?", (panel["id"],)).fetchone()[0]
            cursor = self.conn.execute(
                """INSERT INTO tickets (guild_id, panel_id, owner_id, number, state, created_at)
                   VALUES (?, ?, ?, ?, 'creating', ?)""",
                (panel["guild_id"], panel["id"], owner_id, number, int(time.time())),
            )
        return self.get_ticket(cursor.lastrowid)

    def activate_ticket(self, ticket_id: int, channel_id: int) -> dict:
        with self.conn:
            self.conn.execute("UPDATE tickets SET channel_id = ?, state = 'open' WHERE id = ?", (channel_id, ticket_id))
        return self.get_ticket(ticket_id)

    def release_ticket(self, ticket_id: int) -> None:
        """Undoes a reservation whose channel was never made, giving its number back if it was the latest."""
        with self.conn:
            row = self.conn.execute("SELECT panel_id, number FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
            if row is None:
                return
            self.conn.execute("DELETE FROM tickets WHERE id = ?", (ticket_id,))
            self.conn.execute(
                "UPDATE panels SET counter = counter - 1 WHERE id = ? AND counter = ?", (row["panel_id"], row["number"])
            )

    def drop_ticket(self, ticket_id: int) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM tickets WHERE id = ?", (ticket_id,))

    def get_ticket(self, ticket_id: int) -> dict | None:
        return self._ticket(self.conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone())

    def ticket_by_channel(self, channel_id: int) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM tickets WHERE channel_id = ? AND state != 'deleted'", (channel_id,)
        ).fetchone()
        return self._ticket(row)

    def tickets_in_states(self, *states: str) -> list[dict]:
        marks = ",".join("?" for _ in states)
        rows = self.conn.execute(f"SELECT * FROM tickets WHERE state IN ({marks})", states).fetchall()
        return [self._ticket(row) for row in rows]

    def set_state(self, ticket_id: int, from_states: tuple[str, ...], to_state: str) -> bool:
        """Changes state only if the ticket is still in an expected one. False means someone got there first."""
        marks = ",".join("?" for _ in from_states)
        closed_at = int(time.time()) if to_state == "closed" else None
        with self.conn:
            cursor = self.conn.execute(
                f"UPDATE tickets SET state = ?, closed_at = COALESCE(?, closed_at) WHERE id = ? AND state IN ({marks})",
                (to_state, closed_at, ticket_id, *from_states),
            )
        return cursor.rowcount > 0

    def set_claimed(self, ticket_id: int, user_id: int | None) -> None:
        with self.conn:
            self.conn.execute("UPDATE tickets SET claimed_by = ? WHERE id = ?", (user_id, ticket_id))

    def set_added(self, ticket_id: int, users: list[int]) -> None:
        with self.conn:
            self.conn.execute("UPDATE tickets SET added_users = ? WHERE id = ?", (json.dumps(users), ticket_id))

    def set_control_message(self, ticket_id: int, message_id: int | None) -> None:
        with self.conn:
            self.conn.execute("UPDATE tickets SET control_message_id = ? WHERE id = ?", (message_id, ticket_id))

    # Team roles

    def set_team_forum(self, guild_id: int, forum_id: int | None, since: int) -> None:
        with self.conn:
            if forum_id is None:
                self.conn.execute("DELETE FROM team_forums WHERE guild_id = ?", (guild_id,))
            else:
                self.conn.execute(
                    """INSERT INTO team_forums (guild_id, forum_id, since) VALUES (?, ?, ?)
                       ON CONFLICT (guild_id) DO UPDATE SET forum_id = excluded.forum_id, since = excluded.since""",
                    (guild_id, forum_id, since),
                )

    def set_team_above(self, guild_id: int, role_id: int | None) -> bool:
        """Sets the role that new team roles go above. False when no team forum is set yet."""
        with self.conn:
            cursor = self.conn.execute("UPDATE team_forums SET above_role_id = ? WHERE guild_id = ?", (role_id, guild_id))
        return cursor.rowcount > 0

    def team_forum(self, guild_id: int) -> dict | None:
        row = self.conn.execute("SELECT * FROM team_forums WHERE guild_id = ?", (guild_id,)).fetchone()
        return dict(row) if row else None

    def team_forums(self) -> list[dict]:
        return [dict(row) for row in self.conn.execute("SELECT * FROM team_forums").fetchall()]

    def add_team(self, guild_id: int, thread_id: int, owner_id: int) -> bool:
        with self.conn:
            cursor = self.conn.execute(
                "INSERT OR IGNORE INTO teams (thread_id, guild_id, owner_id, state) VALUES (?, ?, ?, 'waiting')",
                (thread_id, guild_id, owner_id),
            )
        return cursor.rowcount > 0

    def get_team(self, thread_id: int) -> dict | None:
        row = self.conn.execute("SELECT * FROM teams WHERE thread_id = ?", (thread_id,)).fetchone()
        return dict(row) if row else None

    def team_by_message(self, message_id: int) -> dict | None:
        row = self.conn.execute("SELECT * FROM teams WHERE message_id = ?", (message_id,)).fetchone()
        return dict(row) if row else None

    def all_teams(self) -> list[dict]:
        return [dict(row) for row in self.conn.execute("SELECT * FROM teams").fetchall()]

    def count_teams(self, guild_id: int) -> int:
        return self.conn.execute(
            "SELECT COUNT(*) FROM teams WHERE guild_id = ? AND state = 'done'", (guild_id,)
        ).fetchone()[0]

    def set_team_state(self, thread_id: int, from_state: str, to_state: str) -> bool:
        """Changes state only from the expected one, so two quick replies cannot create two roles."""
        with self.conn:
            cursor = self.conn.execute(
                "UPDATE teams SET state = ? WHERE thread_id = ? AND state = ?", (to_state, thread_id, from_state)
            )
        return cursor.rowcount > 0

    def finish_team(self, thread_id: int, role_id: int, message_id: int) -> None:
        with self.conn:
            self.conn.execute(
                "UPDATE teams SET state = 'done', role_id = ?, message_id = ? WHERE thread_id = ?",
                (role_id, message_id, thread_id),
            )

    def delete_team(self, thread_id: int) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM teams WHERE thread_id = ?", (thread_id,))
