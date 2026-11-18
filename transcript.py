"""Builds a single-file HTML transcript of a ticket."""

from __future__ import annotations

from datetime import datetime, timezone
from html import escape
from urllib.parse import urlparse

STYLE = """
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:#1e1f22;color:#dbdee1;font:15px/1.45 system-ui,"Segoe UI",Roboto,sans-serif}
header.top{position:sticky;top:0;background:#2b2d31;border-bottom:1px solid #111214;padding:14px 20px}
h1{font-size:17px;margin:0 0 4px;color:#f2f3f5;overflow-wrap:anywhere}header.top p{margin:0;color:#b5bac1;font-size:13px}
main{max-width:940px;margin:0 auto;padding:14px 12px 40px}
article{display:flex;gap:12px;padding:8px;border-radius:6px}article:hover{background:#26272b}
.avatar{width:40px;height:40px;border-radius:50%;background:#3f4147;flex:none}.body{min-width:0;flex:1}
.who b{color:#f2f3f5}.who time{color:#949ba4;font-size:12px;margin-left:6px}
.bot{background:#5865f2;color:#fff;border-radius:3px;padding:0 4px;font-size:10px;font-weight:700;margin-left:6px}
.text{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#00a8fc}
.embed{background:#2b2d31;border-left:4px solid #5865f2;border-radius:4px;padding:9px 13px;margin-top:6px;max-width:540px;white-space:pre-wrap;overflow-wrap:anywhere}
.embed b{display:block;color:#f2f3f5}.file{display:block;margin-top:5px;overflow-wrap:anywhere}
.shot{display:block;max-width:min(400px,100%);max-height:320px;border-radius:5px;margin-top:6px}
"""


def safe_url(value: str | None) -> str | None:
    """Only web links may appear in a transcript."""
    if not value:
        return None
    try:
        return value if urlparse(value).scheme in ("http", "https") else None
    except ValueError:
        return None


def _message(item: dict) -> str:
    avatar = safe_url(item.get("avatar"))
    image = (
        f'<img class="avatar" src="{escape(avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">'
        if avatar
        else '<div class="avatar"></div>'
    )
    stamp = item["time"].astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    parts = [
        f'<div class="who"><b>{escape(item["author"])}</b>'
        f'{"<span class=bot>BOT</span>" if item.get("bot") else ""}<time>{stamp}</time></div>'
    ]
    if item.get("content"):
        parts.append(f'<div class="text">{escape(item["content"])}</div>')
    for file in item.get("files", []):
        url = safe_url(file["url"])
        if not url:
            continue
        if file.get("image"):
            parts.append(
                f'<a href="{escape(url)}" rel="noopener noreferrer" target="_blank">'
                f'<img class="shot" src="{escape(url)}" alt="{escape(file["name"])}" loading="lazy" referrerpolicy="no-referrer"></a>'
            )
        else:
            parts.append(
                f'<a class="file" href="{escape(url)}" rel="noopener noreferrer" target="_blank">{escape(file["name"])}</a>'
            )
    for embed in item.get("embeds", []):
        title = f'<b>{escape(embed["title"])}</b>' if embed.get("title") else ""
        body = escape(embed.get("description") or "")
        if title or body:
            parts.append(f'<div class="embed">{title}{body}</div>')
    return f'<article>{image}<div class="body">{"".join(parts)}</div></article>'


def render_transcript(channel: str, server: str, owner: str, messages: list[dict]) -> str:
    saved = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    summary = f"{server}, opened by {owner}. {len(messages)} messages, saved {saved}."
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src https: http:; style-src 'unsafe-inline'\">"
        f"<title>{escape(channel)} transcript</title><style>{STYLE}</style></head><body>"
        f'<header class="top"><h1>#{escape(channel)}</h1><p>{escape(summary)}</p></header>'
        f'<main>{"".join(_message(item) for item in messages)}</main></body></html>'
    )
