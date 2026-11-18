export interface TranscriptMessage {
  id: string;
  authorName: string;
  authorId: string;
  authorAvatar: string;
  authorIsBot: boolean;
  createdAt: number;
  editedAt: number | null;
  content: string;
  attachments: { name: string; url: string; size: number; contentType: string | null }[];
  embeds: {
    title: string | null;
    description: string | null;
    url: string | null;
    color: number | null;
    author: string | null;
    footer: string | null;
    image: string | null;
    fields: { name: string; value: string }[];
  }[];
  stickers: string[];
}

export interface TranscriptMeta {
  serverName: string;
  channelName: string;
  panelName: string;
  ownerName: string;
  ownerId: string;
  generatedAt: number;
  resolveUser: (id: string) => string | undefined;
  resolveRole: (id: string) => string | undefined;
  resolveChannel: (id: string) => string | undefined;
}

/** Everything written into the transcript passes through here, including usernames. */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const safeUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)(\?|$)/i;

/** Converts Discord markdown into safe HTML. Input is escaped before any tag is added. */
export function renderMarkdown(source: string, meta: TranscriptMeta): string {
  const held: string[] = [];
  const hold = (html: string) => {
    held.push(html);
    return `\u0000${held.length - 1}\u0000`;
  };

  // Control characters from a message must not collide with the placeholders above.
  let text = source.replace(/\u0000/g, '');

  text = text.replace(/```(?:[\w+-]{1,20}\n)?([\s\S]*?)```/g, (_, code: string) =>
    hold(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`),
  );
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${escapeHtml(code)}</code>`));

  text = text.replace(/<a?:(\w{1,32}):(\d{17,20})>/g, (_, name: string) => hold(`<span class="emoji">:${escapeHtml(name)}:</span>`));
  text = text.replace(/<@!?(\d{17,20})>/g, (_, id: string) =>
    hold(`<span class="mention">@${escapeHtml(meta.resolveUser(id) ?? id)}</span>`),
  );
  text = text.replace(/<@&(\d{17,20})>/g, (_, id: string) =>
    hold(`<span class="mention">@${escapeHtml(meta.resolveRole(id) ?? id)}</span>`),
  );
  text = text.replace(/<#(\d{17,20})>/g, (_, id: string) =>
    hold(`<span class="mention">#${escapeHtml(meta.resolveChannel(id) ?? id)}</span>`),
  );
  text = text.replace(/<t:(\d{1,13})(?::[tTdDfFR])?>/g, (_, seconds: string) =>
    hold(`<time>${escapeHtml(new Date(Number(seconds) * 1000).toUTCString())}</time>`),
  );

  const link = (label: string, href: string) => {
    const url = safeUrl(href);
    if (!url) return null;
    return hold(`<a href="${escapeHtml(url)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(label)}</a>`);
  };
  text = text.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (all, label: string, href: string) => link(label, href) ?? all);
  text = text.replace(/https?:\/\/[^\s<>"']+/g, (href) => link(href, href) ?? href);

  let html = escapeHtml(text);
  html = html
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<u>$1</u>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\|\|([^|\n]+)\|\|/g, '<span class="spoiler">$1</span>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\n/g, '<br>');

  return html.replace(/\u0000(\d+)\u0000/g, (_, index: string) => held[Number(index)] ?? '');
}

const fileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
};

const stamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

function renderEmbed(embed: TranscriptMessage['embeds'][number], meta: TranscriptMeta): string {
  const color = embed.color === null ? '#4e5058' : `#${embed.color.toString(16).padStart(6, '0')}`;
  const url = safeUrl(embed.url);
  const image = safeUrl(embed.image);
  const title = embed.title ? renderMarkdown(embed.title, meta) : '';
  return `<div class="embed" style="border-left-color:${color}">
    ${embed.author ? `<div class="embed-author">${escapeHtml(embed.author)}</div>` : ''}
    ${title ? `<div class="embed-title">${url ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(embed.title ?? '')}</a>` : title}</div>` : ''}
    ${embed.description ? `<div class="embed-body">${renderMarkdown(embed.description, meta)}</div>` : ''}
    ${embed.fields.map((field) => `<div class="embed-field"><b>${renderMarkdown(field.name, meta)}</b><div>${renderMarkdown(field.value, meta)}</div></div>`).join('')}
    ${image ? `<img class="embed-image" loading="lazy" referrerpolicy="no-referrer" src="${escapeHtml(image)}" alt="">` : ''}
    ${embed.footer ? `<div class="embed-footer">${escapeHtml(embed.footer)}</div>` : ''}
  </div>`;
}

function renderAttachment(file: TranscriptMessage['attachments'][number]): string {
  const url = safeUrl(file.url);
  if (!url) return '';
  const name = escapeHtml(file.name);
  const isImage = file.contentType?.startsWith('image/') || IMAGE_FILE.test(file.name);
  if (isImage) {
    return `<a href="${escapeHtml(url)}" rel="noopener noreferrer nofollow" target="_blank"><img class="attachment-image" loading="lazy" referrerpolicy="no-referrer" src="${escapeHtml(url)}" alt="${name}"></a>`;
  }
  return `<a class="file" href="${escapeHtml(url)}" rel="noopener noreferrer nofollow" target="_blank">${name} <span>${fileSize(file.size)}</span></a>`;
}

function renderOne(message: TranscriptMessage, meta: TranscriptMeta): string {
  const avatar = safeUrl(message.authorAvatar);
  return `<article class="message" id="m${escapeHtml(message.id)}">
    ${avatar ? `<img class="avatar" loading="lazy" referrerpolicy="no-referrer" src="${escapeHtml(avatar)}" alt="">` : '<div class="avatar"></div>'}
    <div class="body">
      <header><b title="${escapeHtml(message.authorId)}">${escapeHtml(message.authorName)}</b>${message.authorIsBot ? '<span class="bot">BOT</span>' : ''}<time>${stamp(message.createdAt)}</time>${message.editedAt ? '<span class="edited">(edited)</span>' : ''}</header>
      ${message.content ? `<div class="content">${renderMarkdown(message.content, meta)}</div>` : ''}
      ${message.attachments.map(renderAttachment).join('')}
      ${message.embeds.map((embed) => renderEmbed(embed, meta)).join('')}
      ${message.stickers.map((sticker) => `<div class="sticker">Sticker: ${escapeHtml(sticker)}</div>`).join('')}
    </div>
  </article>`;
}

/** Builds a single self-contained HTML file. Scripts are blocked by its content security policy. */
export function renderTranscript(messages: TranscriptMessage[], meta: TranscriptMeta): string {
  const title = `${meta.channelName} transcript`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#1e1f22;color:#dbdee1;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.top{position:sticky;top:0;background:#2b2d31;border-bottom:1px solid #111214;padding:14px 20px;z-index:1}.top h1{font-size:17px;margin:0 0 4px;color:#f2f3f5;overflow-wrap:anywhere}.top p{margin:0;color:#b5bac1;font-size:13px}
main{max-width:980px;margin:0 auto;padding:16px 12px 48px}.message{display:flex;gap:12px;padding:8px;border-radius:6px}.message:hover{background:#26272b}.avatar{width:40px;height:40px;border-radius:50%;background:#3f4147;flex:none}.body{min-width:0;flex:1}
header{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}header b{color:#f2f3f5}header time,.edited{font-size:12px;color:#949ba4}.bot{background:#5865f2;color:#fff;border-radius:3px;padding:0 4px;font-size:10px;font-weight:700}
.content{overflow-wrap:anywhere}a{color:#00a8fc}pre{background:#111214;padding:10px;border-radius:5px;overflow:auto;white-space:pre-wrap}code{background:#111214;padding:1px 4px;border-radius:3px;font:13px ui-monospace,Consolas,monospace}pre code{padding:0}blockquote{margin:2px 0;padding-left:10px;border-left:3px solid #4e5058}
.mention{background:#3c4270;color:#c9cdfb;border-radius:3px;padding:0 3px}.spoiler{background:#111214;color:#111214;border-radius:3px}.spoiler:hover{color:#dbdee1}.embed{background:#2b2d31;border-left:4px solid;border-radius:4px;padding:10px 14px;margin-top:6px;max-width:560px;overflow-wrap:anywhere}.embed-author{font-size:13px;font-weight:600}.embed-title{font-weight:700;margin-bottom:4px;color:#f2f3f5}.embed-field{margin-top:8px}.embed-footer{margin-top:8px;font-size:12px;color:#949ba4}.embed-image,.attachment-image{display:block;max-width:min(420px,100%);max-height:340px;border-radius:5px;margin-top:6px}
.file{display:inline-block;background:#2b2d31;border:1px solid #111214;border-radius:5px;padding:9px 12px;margin-top:6px;overflow-wrap:anywhere}.file span{color:#949ba4;font-size:12px}.sticker{color:#949ba4;font-style:italic}.empty{text-align:center;color:#949ba4;padding:40px}
</style>
</head>
<body>
<div class="top"><h1>#${escapeHtml(meta.channelName)}</h1><p>${escapeHtml(meta.serverName)} · ${escapeHtml(meta.panelName)} · Opened by ${escapeHtml(meta.ownerName)} (${escapeHtml(meta.ownerId)}) · ${messages.length} message${messages.length === 1 ? '' : 's'} · Saved ${stamp(meta.generatedAt)}</p></div>
<main>${messages.length ? messages.map((message) => renderOne(message, meta)).join('\n') : '<p class="empty">No messages.</p>'}</main>
</body>
</html>`;
}
