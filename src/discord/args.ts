export type OptionType = 'string' | 'user' | 'mentionable' | 'role' | 'channel' | 'integer';

export interface OptionDef {
  name: string;
  description: string;
  type: OptionType;
  required?: boolean;
  choices?: string[];
}

export type RawArg = { kind: 'text'; value: string } | { kind: 'number'; value: number } | { kind: 'user' | 'role' | 'channel' | 'id'; id: string };

const ID = /^\d{17,20}$/;

function readToken(type: OptionType, token: string): RawArg | null {
  const user = /^<@!?(\d{17,20})>$/.exec(token);
  const role = /^<@&(\d{17,20})>$/.exec(token);
  const channel = /^<#(\d{17,20})>$/.exec(token);
  switch (type) {
    case 'user':
      if (user) return { kind: 'user', id: user[1]! };
      return ID.test(token) ? { kind: 'user', id: token } : null;
    case 'role':
      if (role) return { kind: 'role', id: role[1]! };
      return ID.test(token) ? { kind: 'role', id: token } : null;
    case 'mentionable':
      if (user) return { kind: 'user', id: user[1]! };
      if (role) return { kind: 'role', id: role[1]! };
      return ID.test(token) ? { kind: 'id', id: token } : null;
    case 'channel':
      if (channel) return { kind: 'channel', id: channel[1]! };
      return ID.test(token) ? { kind: 'channel', id: token } : null;
    case 'integer':
      return /^-?\d{1,15}$/.test(token) ? { kind: 'number', value: Number(token) } : null;
    default:
      return null;
  }
}

export type ParsedArgs = { ok: true; args: Record<string, RawArg> } | { ok: false; missing: string };

/**
 * Reads prefix command arguments in order. Optional arguments are skipped when the next word does
 * not fit, so `$new I need help` and `$new @user I need help` both work. Text takes the remainder.
 */
export function parseArgs(options: OptionDef[], input: string): ParsedArgs {
  const args: Record<string, RawArg> = {};
  let rest = input.trim();

  for (const option of options) {
    if (option.type === 'string') {
      const lastOption = option === options[options.length - 1];
      const word = lastOption ? rest : (/^\S+/.exec(rest)?.[0] ?? '');
      const usable = option.choices ? option.choices.includes(word.toLowerCase()) : word.length > 0;
      if (usable) {
        args[option.name] = { kind: 'text', value: option.choices ? word.toLowerCase() : word };
        rest = rest.slice(word.length).trim();
      } else if (option.required) {
        return { ok: false, missing: option.name };
      }
      continue;
    }
    const token = /^\S+/.exec(rest)?.[0] ?? '';
    const value = token ? readToken(option.type, token) : null;
    if (value) {
      args[option.name] = value;
      rest = rest.slice(token.length).trim();
    } else if (option.required) {
      return { ok: false, missing: option.name };
    }
  }
  return { ok: true, args };
}
