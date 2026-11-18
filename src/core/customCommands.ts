import vm from 'node:vm';
import type { CustomCommand } from '../config/schema.js';

export interface CommandMatch {
  args: string[];
  regex: Record<string, string>;
}

const REGEX_TIMEOUT_MS = 50;

/**
 * Runs an admin-written pattern against member-written text inside a time limit, so one badly
 * written pattern cannot freeze the whole bot.
 */
function safeRegexExec(pattern: string, flags: string, input: string): Record<string, string> | null {
  try {
    const json = vm.runInNewContext(
      `(() => {
        const match = new RegExp(pattern, flags).exec(input);
        if (!match) return null;
        const out = {};
        match.forEach((value, index) => { out[index] = value ?? ''; });
        for (const [key, value] of Object.entries(match.groups ?? {})) out[key] = value ?? '';
        return JSON.stringify(out);
      })()`,
      { pattern, flags, input },
      { timeout: REGEX_TIMEOUT_MS },
    ) as string | null;
    return json ? (JSON.parse(json) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function splitArguments(raw: string, command: CustomCommand): string[] {
  const text = raw.trim();
  if (command.argumentCount === 0 || text.length === 0) return [];
  if (command.argumentCount === 1) return [text];
  const pieces = text.split(command.argumentSeparator);
  const head = pieces.slice(0, command.argumentCount - 1);
  const tail = pieces.slice(command.argumentCount - 1).join(command.argumentSeparator);
  return (tail ? [...head, tail] : head).map((piece) => piece.trim());
}

/** Decides whether a message triggers a custom command. */
export function matchCustomCommand(command: CustomCommand, content: string): CommandMatch | null {
  const fold = (value: string) => (command.caseSensitive ? value : value.toLowerCase());
  const text = content.trim();

  if (command.triggerType === 'regex') {
    const regex = safeRegexExec(command.trigger, command.caseSensitive ? '' : 'i', text);
    return regex ? { args: [], regex } : null;
  }

  if (command.triggerType === 'wildcard') {
    const pattern = command.trigger.split('*').map(escapeRegex).join('[\\s\\S]*');
    const regex = safeRegexExec(`^${pattern}$`, command.caseSensitive ? '' : 'i', text);
    return regex ? { args: [], regex: {} } : null;
  }

  if (fold(text) === fold(command.trigger)) return { args: [], regex: {} };
  if (command.argumentCount > 0 && fold(text).startsWith(`${fold(command.trigger)} `)) {
    return { args: splitArguments(text.slice(command.trigger.length), command), regex: {} };
  }
  return null;
}

export function findCustomCommand(
  commands: CustomCommand[],
  content: string,
): { command: CustomCommand; match: CommandMatch } | null {
  for (const command of commands) {
    const match = matchCustomCommand(command, content);
    if (match) return { command, match };
  }
  return null;
}
