import type { APIEmbed } from 'discord.js';
import type { MessageTemplate } from '../config/schema.js';
import { renderVariables, type VariableContext } from './variables.js';

export interface RenderedMessage {
  content: string;
  embeds: APIEmbed[];
  allowedMentions: { parse: ('users' | 'roles' | 'everyone')[] };
}

const EMBED_TOTAL_LIMIT = 6000;

const httpUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/** Renders a saved message template into a payload Discord will accept. */
export function renderMessage(template: MessageTemplate, ctx: VariableContext): RenderedMessage {
  const fill = (value: string) => renderVariables(value, ctx).trim();
  let budget = EMBED_TOTAL_LIMIT;
  const take = (value: string, max: number) => {
    const text = value.slice(0, Math.min(max, Math.max(budget, 0)));
    budget -= text.length;
    return text;
  };

  const embeds: APIEmbed[] = [];
  for (const source of template.embeds) {
    const embed: APIEmbed = { color: Number.parseInt(source.color.slice(1), 16) };
    const title = take(fill(source.title), 256);
    const description = take(fill(source.description), 4096);
    const footer = take(fill(source.footer), 2048);
    const author = take(fill(source.authorName), 256);
    if (title) embed.title = title;
    if (description) embed.description = description;
    if (footer) embed.footer = { text: footer, icon_url: httpUrl(fill(source.footerIcon)) };
    if (author) embed.author = { name: author, icon_url: httpUrl(fill(source.authorIcon)) };

    const url = httpUrl(fill(source.url));
    const image = httpUrl(fill(source.image));
    const thumbnail = httpUrl(fill(source.thumbnail));
    if (url && title) embed.url = url;
    if (image) embed.image = { url: image };
    if (thumbnail) embed.thumbnail = { url: thumbnail };
    if (source.timestamp) embed.timestamp = new Date(ctx.now ?? Date.now()).toISOString();

    const fields = source.fields
      .map((field) => ({
        name: take(fill(field.name), 256),
        value: take(fill(field.value), 1024),
        inline: field.inline,
      }))
      .filter((field) => field.name && field.value);
    if (fields.length > 0) embed.fields = fields;

    const hasBody = title || description || footer || author || image || thumbnail || fields.length > 0;
    if (hasBody) embeds.push(embed);
  }

  // Only text written by server admins can ping everyone. Member input is neutralized earlier.
  const raw = [template.content, ...template.embeds.map((embed) => embed.description)].join(' ');
  const parse: RenderedMessage['allowedMentions']['parse'] = ['users', 'roles'];
  if (/@(everyone|here)/.test(raw)) parse.push('everyone');

  return { content: fill(template.content).slice(0, 2000), embeds, allowedMentions: { parse } };
}

export const isEmptyMessage = (message: RenderedMessage): boolean =>
  message.content.length === 0 && message.embeds.length === 0;
