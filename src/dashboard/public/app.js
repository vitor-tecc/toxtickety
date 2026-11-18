// The settings forms are generated from the bot's config schema, so new settings appear here on their own.

const root = document.getElementById('app');

const state = {
  me: null,
  schema: null,
  guilds: [],
  guild: null,
  view: 'panels',
  panelId: null,
  section: 'general',
  draft: null,
  dirty: false,
  errors: {},
};

// Helpers --------------------------------------------------------------------------------------

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

const clone = (value) => structuredClone(value);
let uid = 0;
const nextId = () => `f${(uid += 1)}`;

function toast(message, bad = false) {
  const note = h('div', { class: `toast${bad ? ' bad' : ''}` }, message);
  document.getElementById('toast').append(note);
  setTimeout(() => note.remove(), bad ? 7000 : 3500);
}

class ApiError extends Error {
  constructor(message, status, issues) {
    super(message);
    this.status = status;
    this.issues = issues ?? [];
  }
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Toxtickety': '1' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error ?? 'That request failed.', response.status, data.issues);
  return data;
}

const report = (error) => toast(error.message ?? 'That request failed.', true);

const ENUM_LABELS = {
  primary: 'Blue', secondary: 'Gray', success: 'Green', danger: 'Red',
  never: 'Never', close: 'When closed', delete: 'When deleted', both: 'When closed or deleted',
  nothing: 'Do nothing', messageCheck: 'Check for a message', trigger: 'Run on an event',
  notFound: 'No message arrives in time', found: 'A message arrives in time',
  anyone: 'Anyone', owner: 'Ticket owner', support: 'Support team',
  once: 'Once, then stop', untilStopped: 'Until stopped',
  restart: 'Restart the timer', continue: 'Keep the timer running',
  stop: 'Stop checking', keepChecking: 'Keep checking',
  created: 'Ticket created', closed: 'Ticket closed', reopened: 'Ticket reopened',
  ownerLeft: 'Ticket owner left', closeAsk: 'Close confirmation sent',
  customCommand: 'Run a custom command', strict: 'Exact match', wildcard: 'Wildcard (*)', regex: 'Regular expression',
};
const enumLabel = (value, context) => {
  if (context === 'action' && value === 'close') return 'Close the ticket';
  if (context === 'action' && value === 'delete') return 'Delete the ticket';
  if (context === 'missing' && value === 'close') return 'Close the ticket';
  if (context === 'missing' && value === 'delete') return 'Delete the ticket';
  return ENUM_LABELS[value] ?? value;
};

const PERMISSION_LABELS = (name) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/ ([A-Z])/g, (m) => m.toLowerCase());

function defaultFor(schema) {
  if (schema.hidden) return undefined;
  if (schema.default !== undefined) return clone(schema.default);
  if (schema.type === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const value = defaultFor(child);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 0;
  return schema.enum?.[0] ?? '';
}

/** Fills in anything missing from a default, because schema defaults can be partial objects. */
function complete(schema, value) {
  if (schema.type !== 'object' || !schema.properties) return value;
  const out = { ...(value ?? {}) };
  for (const [key, child] of Object.entries(schema.properties)) {
    if (out[key] === undefined) {
      const fallback = defaultFor(child);
      if (fallback !== undefined) out[key] = fallback;
    }
    if (child.type === 'object') out[key] = complete(child, out[key]);
    if (child.type === 'array' && child.items?.type === 'object' && Array.isArray(out[key])) {
      out[key] = out[key].map((item) => complete(child.items, item));
    }
  }
  return out;
}

const newItem = (schema) => complete(schema, defaultFor(schema));

function markDirty() {
  state.dirty = true;
  state.refreshStub?.();
  renderSaveBar();
}

// Generated form -------------------------------------------------------------------------------

function pickerOptions(picker) {
  const guild = state.guild;
  if (picker === 'role') return guild.roles.map((role) => ({ value: role.id, label: `@${role.name}` }));
  if (picker === 'channel') return guild.channels.map((channel) => ({ value: channel.id, label: `#${channel.name}` }));
  if (picker === 'category') return guild.categories.map((category) => ({ value: category.id, label: category.name }));
  if (picker === 'panel') return guild.panels.map((panel) => ({ value: panel.id, label: panel.name }));
  return [];
}

function wrapField(schema, path, control, id) {
  const error = state.errors[path.join('.')];
  return h(
    'div',
    { class: `field${error ? ' error' : ''}` },
    h('label', { htmlFor: id }, schema.title ?? path[path.length - 1]),
    control,
    schema.description && h('span', { class: 'hint' }, schema.description),
    error && h('span', { class: 'error-text' }, error),
  );
}

function chipField(schema, path, list, set) {
  const options = pickerOptions(schema.picker);
  const labelFor = (value) => options.find((option) => option.value === value)?.label ?? `Unknown (${value})`;
  const id = nextId();
  const chips = h('div', { class: 'chips' });
  const select = h('select', { class: 'input', id });

  const draw = () => {
    chips.replaceChildren(
      ...list().map((value) =>
        h(
          'span',
          { class: 'chip' },
          labelFor(value),
          h('button', {
            type: 'button',
            ariaLabel: `Remove ${labelFor(value)}`,
            textContent: '×',
            onclick: () => {
              set(list().filter((item) => item !== value));
              draw();
            },
          }),
        ),
      ),
    );
    const free = options.filter((option) => !list().includes(option.value));
    select.replaceChildren(
      h('option', { value: '' }, free.length ? 'Add…' : 'Nothing else to add'),
      ...free.map((option) => h('option', { value: String(option.value) }, option.label)),
    );
  };

  select.addEventListener('change', () => {
    if (!select.value) return;
    const value = schema.picker === 'panel' ? Number(select.value) : select.value;
    set([...list(), value]);
    draw();
  });
  draw();
  return wrapField(schema, path, h('div', { class: 'row-stack' }, chips, select), id);
}

function textListField(schema, path, list, set) {
  const id = nextId();
  const input = h('input', {
    class: 'input',
    id,
    value: list().join(', '),
    oninput: () => set(input.value.split(/[\s,]+/).filter(Boolean)),
  });
  return wrapField(schema, path, input, id);
}

function permissionsField(schema, path, value, onChange) {
  const names = schema.properties.allow.items.enum;
  const table = h(
    'table',
    { class: 'perm' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Permission'), ['Allow', 'Default', 'Deny'].map((text) => h('th', { scope: 'col' }, text)))),
    h(
      'tbody',
      {},
      names.map((name) => {
        const group = nextId();
        const current = value.allow.includes(name) ? 'allow' : value.deny.includes(name) ? 'deny' : 'neutral';
        const radio = (mode, label) =>
          h('td', {}, h('input', {
            type: 'radio',
            name: group,
            checked: current === mode,
            ariaLabel: `${label}: ${PERMISSION_LABELS(name)}`,
            onchange: () => {
              value.allow = value.allow.filter((item) => item !== name);
              value.deny = value.deny.filter((item) => item !== name);
              if (mode === 'allow') value.allow.push(name);
              if (mode === 'deny') value.deny.push(name);
              onChange(value);
            },
          }));
        return h('tr', {}, h('td', {}, PERMISSION_LABELS(name)), radio('allow', 'Allow'), radio('neutral', 'Default'), radio('deny', 'Deny'));
      }),
    ),
  );
  return h('details', { class: 'fold' }, h('summary', {}, schema.title), h('div', { class: 'fold-body' }, table));
}

function arrayField(schema, path, list, set) {
  const itemSchema = schema.items;
  const box = h('div', { class: 'group' });
  const label = schema.itemLabel ?? 'Item';

  const draw = () => {
    const items = list();
    const parts = [
      h('h3', {}, schema.title),
      schema.description && h('span', { class: 'hint' }, schema.description),
      ...items.map((item, index) =>
        h(
          'div',
          { class: 'item' },
          h(
            'div',
            { class: 'item-head' },
            h('b', {}, item.name || item.title || item.display || `${label} ${index + 1}`),
            h('button', {
              type: 'button',
              class: 'btn void small',
              textContent: 'Remove',
              ariaLabel: `Remove ${label} ${index + 1}`,
              onclick: () => {
                set(list().filter((_, position) => position !== index));
                draw();
              },
            }),
          ),
          objectFields(itemSchema, [...path, index], item),
        ),
      ),
      (schema.maxItems === undefined || items.length < schema.maxItems) &&
        h('div', {}, h('button', {
          type: 'button',
          class: 'btn small',
          textContent: `Add ${label.toLowerCase()}`,
          onclick: () => {
            set([...list(), newItem(itemSchema)]);
            draw();
          },
        })),
    ];
    box.replaceChildren(...parts.filter(Boolean));
  };
  draw();
  return box;
}

function objectFields(schema, path, value) {
  const output = [];
  const conditional = [];
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (child.hidden) continue;
    const node = fieldFor(child, [...path, key], () => value[key], (next) => {
      value[key] = next;
      markDirty();
      for (const sync of conditional) sync();
    });
    if (child.when) {
      const sync = () => {
        const visible = Object.entries(child.when).every(([other, wanted]) => value[other] === wanted);
        node.hidden = !visible;
        node.style.display = visible ? '' : 'none';
      };
      conditional.push(sync);
      sync();
    }
    output.push(node);
  }
  return output;
}

function fieldFor(schema, path, read, write) {
  const id = nextId();

  if (schema.kind === 'permissions') return permissionsField(schema, path, read(), write);

  if (schema.type === 'object') {
    if (schema.kind === 'message') {
      return h('details', { class: 'fold' }, h('summary', {}, schema.title), h('div', { class: 'fold-body' }, schema.description && h('span', { class: 'hint' }, schema.description), objectFields(schema, path, read())));
    }
    return h('div', { class: 'group' }, h('h3', {}, schema.title), objectFields(schema, path, read()));
  }

  if (schema.type === 'array') {
    if (schema.items?.type === 'object') return arrayField(schema, path, read, write);
    if (schema.picker) return chipField(schema, path, read, write);
    return textListField(schema, path, read, write);
  }

  if (schema.type === 'boolean') {
    return h(
      'label',
      { class: 'switch' },
      h('input', { type: 'checkbox', role: 'switch', checked: read(), onchange: (event) => write(event.target.checked) }),
      h('span', {}, h('b', {}, schema.title), schema.description && h('span', { class: 'hint' }, schema.description)),
    );
  }

  if (schema.picker) {
    const numeric = schema.type === 'integer' || schema.type === 'number';
    const select = h(
      'select',
      { class: 'input', id, onchange: (event) => write(numeric ? Number(event.target.value) : event.target.value) },
      !numeric && h('option', { value: '' }, 'None'),
      pickerOptions(schema.picker).map((option) => h('option', { value: String(option.value) }, option.label)),
    );
    select.value = String(read() ?? '');
    if (numeric && select.value === '' && select.options.length > 0) {
      select.selectedIndex = 0;
      write(Number(select.value));
    }
    return wrapField(schema, path, select, id);
  }

  if (schema.enum) {
    const context = path.at(-2) === 'action' ? 'action' : path.at(-1) === 'missingUser' ? 'missing' : '';
    const select = h(
      'select',
      { class: 'input', id, onchange: (event) => write(event.target.value) },
      schema.enum.map((value) => h('option', { value }, enumLabel(value, context))),
    );
    select.value = read();
    return wrapField(schema, path, select, id);
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    const input = h('input', {
      class: 'input',
      id,
      type: 'number',
      min: schema.minimum,
      max: schema.maximum,
      value: read(),
      oninput: (event) => write(event.target.value === '' ? 0 : Number(event.target.value)),
    });
    return wrapField(schema, path, input, id);
  }

  if (schema.multiline) {
    return wrapField(schema, path, h('textarea', { class: 'input', id, maxLength: schema.maxLength, value: read(), oninput: (event) => write(event.target.value) }), id);
  }
  return wrapField(schema, path, h('input', {
    class: 'input',
    id,
    type: schema.format === 'color' ? 'color' : 'text',
    maxLength: schema.maxLength,
    value: read(),
    oninput: (event) => write(event.target.value),
  }), id);
}

// Saving ---------------------------------------------------------------------------------------

function renderSaveBar() {
  document.querySelector('.savebar')?.remove();
  if (!state.dirty) return;
  document.body.append(
    h(
      'div',
      { class: 'savebar' },
      h('span', {}, 'You have unsaved changes'),
      h('button', { type: 'button', class: 'btn', textContent: 'Discard', onclick: discard }),
      h('button', { type: 'button', class: 'btn primary', textContent: 'Save changes', onclick: save }),
    ),
  );
}

function discard() {
  state.dirty = false;
  state.errors = {};
  loadDraft();
  render();
}

function confirmLeave() {
  if (!state.dirty) return true;
  if (!window.confirm('Discard your unsaved changes?')) return false;
  state.dirty = false;
  state.errors = {};
  return true;
}

async function save() {
  try {
    state.errors = {};
    if (state.view === 'panels') {
      // The counter keeps moving while this page is open, so only send it when it was edited here.
      const saved = state.guild.panels.find((item) => item.id === state.panelId);
      const body = { ...state.draft, count: state.draft.count === saved.count ? undefined : state.draft.count };
      const panel = await api(`/guilds/${state.guild.id}/panels/${state.panelId}`, { method: 'PUT', body });
      state.guild.panels = state.guild.panels.map((item) => (item.id === panel.id ? panel : item));
    } else {
      state.guild.config = await api(`/guilds/${state.guild.id}/config`, { method: 'PUT', body: state.draft });
    }
    state.dirty = false;
    loadDraft();
    render();
    toast('Changes saved');
  } catch (error) {
    if (error.issues?.length) {
      for (const issue of error.issues) {
        const path = state.view === 'panels' ? issue.path.replace(/^config\./, '') : issue.path;
        state.errors[path] = issue.message;
      }
      const first = error.issues[0];
      const section = first.path.replace(/^config\./, '').split('.')[0];
      if (state.view === 'panels' && state.schema.panel.properties[section]) state.section = section;
      render();
      toast(`${error.message} ${first.message}`, true);
    } else {
      report(error);
    }
  }
}

function loadDraft() {
  if (state.view === 'panels') {
    const panel = state.guild?.panels.find((item) => item.id === state.panelId);
    state.draft = panel ? clone({ name: panel.name, count: panel.count, config: panel.config }) : null;
  } else if (['server', 'permissions', 'custom'].includes(state.view)) {
    state.draft = clone(state.guild.config);
  } else {
    state.draft = null;
  }
}

// Views ----------------------------------------------------------------------------------------

function previewName(pattern, count, padding) {
  const filled = pattern
    .replace(/\{count\}/g, String(count + 1).padStart(padding, '0'))
    .replace(/\{panel\.count\}/g, String(count + 1))
    .replace(/\{panel\.name\}/g, state.draft.name)
    .replace(/\{(ticket\.(user|owner)\.(name|nickname)|author\.name)\}/g, state.me.username)
    .replace(/\{[^{}]*\}/g, '');
  const name = filled.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return name.slice(0, 100) || 'ticket';
}

function panelStub(panel) {
  const draft = state.draft;
  const name = h('div', { class: 'stub-name', 'aria-live': 'polite' });
  const pattern = h('input', {
    value: draft.config.ticket.openedName,
    maxLength: 100,
    spellcheck: false,
    oninput: (event) => { draft.config.ticket.openedName = event.target.value; markDirty(); },
  });
  const refresh = () => {
    name.textContent = previewName(draft.config.ticket.openedName, draft.count, draft.config.general.padding);
    if (document.activeElement !== pattern) pattern.value = draft.config.ticket.openedName;
  };
  state.refreshStub = refresh;
  refresh();

  const channel = h('select', { id: 'send-channel' },
    h('option', { value: '' }, 'Choose a channel'),
    state.guild.channels.map((item) => h('option', { value: item.id }, `#${item.name}`)),
  );

  return h(
    'section',
    { class: 'stub', ariaLabel: 'Panel summary' },
    h(
      'div',
      { class: 'stub-main' },
      h('div', { class: 'stub-top' },
        h('input', {
          class: 'stub-title',
          value: draft.name,
          maxLength: 80,
          ariaLabel: 'Panel name',
          oninput: (event) => { draft.name = event.target.value; markDirty(); },
        }),
        h('button', { type: 'button', class: 'btn small', textContent: 'Copy', onclick: () => clonePanel(panel) }),
        h('button', { type: 'button', class: 'btn small void', textContent: 'Delete', onclick: () => deletePanel(panel) }),
      ),
      name,
      h('div', { class: 'stub-pattern' },
        h('label', {}, 'Ticket channel name', pattern),
        h('label', {}, 'Tickets so far',
          h('input', {
            type: 'number',
            min: 0,
            value: draft.count,
            oninput: (event) => { draft.count = Math.max(0, Number(event.target.value) || 0); markDirty(); },
          })),
      ),
    ),
    h(
      'div',
      { class: 'stub-tear' },
      h('label', { htmlFor: 'send-channel' }, 'Post this panel in'),
      channel,
      h('button', {
        type: 'button',
        class: 'btn primary',
        textContent: 'Send panel',
        onclick: async () => {
          if (!channel.value) { toast('Choose a channel first.', true); return; }
          if (state.dirty) { toast('Save your changes before sending the panel.', true); return; }
          try {
            await api(`/guilds/${state.guild.id}/panels/${panel.id}/send`, { method: 'POST', body: { channelId: channel.value } });
            toast('Panel sent');
          } catch (error) { report(error); }
        },
      }),
    ),
  );
}

async function createPanel() {
  const name = window.prompt('Name this panel', 'Support');
  if (!name?.trim()) return;
  try {
    const panel = await api(`/guilds/${state.guild.id}/panels`, { method: 'POST', body: { name } });
    state.guild.panels.push(panel);
    state.panelId = panel.id;
    state.section = 'general';
    loadDraft();
    render();
    toast('Panel created');
  } catch (error) { report(error); }
}

async function clonePanel(panel) {
  if (!confirmLeave()) return;
  try {
    const copy = await api(`/guilds/${state.guild.id}/panels/${panel.id}/clone`, { method: 'POST', body: {} });
    state.guild.panels.push(copy);
    state.panelId = copy.id;
    loadDraft();
    render();
    toast('Panel copied');
  } catch (error) { report(error); }
}

async function deletePanel(panel) {
  if (!window.confirm(`Delete the panel "${panel.name}"? This cannot be undone.`)) return;
  try {
    await api(`/guilds/${state.guild.id}/panels/${panel.id}`, { method: 'DELETE' });
    state.guild.panels = state.guild.panels.filter((item) => item.id !== panel.id);
    state.panelId = state.guild.panels[0]?.id ?? null;
    state.dirty = false;
    loadDraft();
    render();
    toast('Panel deleted');
  } catch (error) { report(error); }
}

function panelsView() {
  const panels = state.guild.panels;
  if (panels.length === 0) {
    return h('div', { class: 'page' },
      h('h1', {}, 'Panels'),
      h('p', { class: 'lede' }, 'A panel is the message members use to open a ticket.'),
      h('div', { class: 'empty' }, h('h2', {}, 'Create your first panel'), h('button', { type: 'button', class: 'btn primary', textContent: 'Create panel', onclick: createPanel })),
    );
  }
  const panel = panels.find((item) => item.id === state.panelId) ?? panels[0];
  if (state.panelId !== panel.id || !state.draft) {
    state.panelId = panel.id;
    loadDraft();
  }
  const sections = Object.entries(state.schema.panel.properties);
  const current = state.schema.panel.properties[state.section] ?? sections[0][1];

  const switcher = h('select', {
    class: 'input',
    ariaLabel: 'Panel',
    onchange: (event) => {
      if (!confirmLeave()) { event.target.value = String(state.panelId); return; }
      state.panelId = Number(event.target.value);
      loadDraft();
      render();
    },
  }, panels.map((item) => h('option', { value: String(item.id) }, item.name)));
  switcher.value = String(panel.id);

  return h('div', { class: 'page' },
    h('div', { class: 'row spread page-head' },
      h('h1', {}, 'Panels'),
      h('div', { class: 'row' }, h('div', {}, switcher), h('button', { type: 'button', class: 'btn', textContent: 'New panel', onclick: createPanel })),
    ),
    panelStub(panel),
    h('div', { class: 'editor' },
      h('div', { class: 'rail', role: 'tablist', ariaLabel: 'Panel settings' },
        sections.map(([key, schema]) => h('button', {
          type: 'button',
          role: 'tab',
          ariaSelected: String(key === state.section),
          textContent: schema.title,
          onclick: () => { state.section = key; render(); },
        })),
      ),
      h('div', { class: 'form', role: 'tabpanel' },
        h('h2', {}, current.title),
        objectFields(current, [state.section], state.draft.config[state.section]),
      ),
    ),
  );
}

function serverView() {
  const schema = state.schema.guild.properties.general;
  return h('div', { class: 'page' },
    h('h1', {}, 'Server settings'),
    h('p', { class: 'lede' }, 'These settings apply to every panel on this server.'),
    h('div', { class: 'form' }, objectFields(schema, ['general'], state.draft.general)),
  );
}

function permissionsView() {
  const schema = state.schema.guild.properties.commands;
  return h('div', { class: 'page' },
    h('h1', {}, 'Command permissions'),
    h('p', { class: 'lede' }, 'Choose who can run each command, and where.'),
    h('div', { class: 'form' },
      Object.entries(schema.properties).map(([name, rule]) =>
        h('details', { class: 'fold' }, h('summary', {}, name), h('div', { class: 'fold-body' }, objectFields(rule, ['commands', name], state.draft.commands[name]))),
      ),
    ),
  );
}

function customView() {
  const schema = state.schema.guild.properties.customCommands;
  return h('div', { class: 'page' },
    h('h1', {}, 'Custom commands'),
    h('p', { class: 'lede' }, 'Saved replies your team can trigger by typing a word or phrase.'),
    h('div', { class: 'form' }, arrayField({ ...schema, title: 'Commands' }, ['customCommands'], () => state.draft.customCommands, (next) => { state.draft.customCommands = next; markDirty(); })),
  );
}

async function statsView() {
  const stats = await api(`/guilds/${state.guild.id}/stats`);
  const max = Math.max(1, ...stats.activity.map((day) => day.count));
  const days = [];
  for (let offset = 29; offset >= 0; offset -= 1) {
    const day = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    days.push({ day, count: stats.activity.find((row) => row.day === day)?.count ?? 0 });
  }
  const total = stats.claimed.reduce((sum, row) => sum + row.count, 0);
  return h('div', { class: 'page' },
    h('h1', {}, 'Statistics'),
    h('p', { class: 'lede' }, 'How your ticket queues are doing.'),
    h('div', { class: 'section' },
      h('h2', {}, 'Tickets opened in the last 30 days'),
      h('div', { class: 'bars', role: 'img', ariaLabel: `${days.reduce((sum, row) => sum + row.count, 0)} tickets opened in the last 30 days` },
        days.map((row) => {
          const bar = h('div', { title: `${row.day}: ${row.count}` });
          bar.style.height = `${Math.max(row.count ? 3 : 0, (row.count / max) * 100)}%`;
          return bar;
        }),
      ),
    ),
    h('div', { class: 'section' },
      h('h2', {}, 'Panels'),
      h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Panel'), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Open'), h('th', { class: 'num' }, 'Closed'), h('th', { class: 'num' }, 'Days tracked'))),
        h('tbody', {}, stats.panels.map((panel) => h('tr', {},
          h('td', {}, panel.name), h('td', { class: 'num' }, String(panel.total)), h('td', { class: 'num' }, String(panel.open)), h('td', { class: 'num' }, String(panel.closed)),
          h('td', { class: 'num' }, String(Math.floor((Date.now() - panel.createdAt) / 86_400_000))),
        ))),
      ),
    ),
    h('div', { class: 'section' },
      h('h2', {}, 'Claimed tickets resolved'),
      stats.claimed.length === 0
        ? h('p', { class: 'hint' }, 'Deleted tickets that were still claimed will be counted here.')
        : h('table', { class: 'table' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Team member'), h('th', { class: 'num' }, 'Tickets'), h('th', { class: 'num' }, 'Share'))),
            h('tbody', {}, stats.claimed.map((row) => h('tr', {}, h('td', {}, row.name), h('td', { class: 'num' }, String(row.count)), h('td', { class: 'num' }, `${Math.round((row.count / total) * 100)}%`)))),
          ),
    ),
  );
}

async function historyView() {
  const entries = await api(`/guilds/${state.guild.id}/history`);
  return h('div', { class: 'page' },
    h('h1', {}, 'Change history'),
    h('p', { class: 'lede' }, 'Every change made from this dashboard.'),
    entries.length === 0
      ? h('p', { class: 'hint' }, 'Changes will appear here once someone saves a setting.')
      : h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'What'))),
          h('tbody', {}, entries.map((entry) => h('tr', {},
            h('td', {}, new Date(entry.at).toLocaleString()), h('td', {}, entry.username), h('td', {}, entry.detail ? `${entry.action}: ${entry.detail}` : entry.action),
          ))),
        ),
  );
}

function backupView() {
  const file = h('input', { type: 'file', accept: 'application/json,.json', class: 'input', id: 'restore-file' });
  const owner = state.guild.isOwner;
  return h('div', { class: 'page' },
    h('h1', {}, 'Backup and restore'),
    h('p', { class: 'lede' }, 'Download your panels and settings, or copy them from another server. Tickets are not included.'),
    !owner && h('p', { class: 'hint' }, 'Only the server owner can use backups.'),
    h('div', { class: 'section' },
      h('h2', {}, 'Download a backup'),
      h('div', {}, h('a', { class: 'btn primary', href: owner ? `/api/guilds/${state.guild.id}/backup` : undefined, download: '', 'aria-disabled': owner ? undefined : 'true' }, 'Download backup')),
    ),
    h('div', { class: 'section' },
      h('h2', {}, 'Restore a backup'),
      h('p', { class: 'hint' }, 'Server settings are replaced and the backup’s panels are added. Roles and channels from another server must be selected again.'),
      h('div', { class: 'field' }, h('label', { htmlFor: 'restore-file' }, 'Backup file'), file),
      h('div', {}, h('button', {
        type: 'button',
        class: 'btn void',
        textContent: 'Restore backup',
        disabled: !owner,
        onclick: async () => {
          const chosen = file.files[0];
          if (!chosen) { toast('Choose a backup file first.', true); return; }
          if (!window.confirm('Replace this server’s settings with this backup?')) return;
          try {
            await api(`/guilds/${state.guild.id}/restore`, { method: 'POST', body: JSON.parse(await chosen.text()) });
            await selectGuild(state.guild.id);
            toast('Backup restored');
          } catch (error) { report(error instanceof SyntaxError ? new Error('That file is not a valid backup.') : error); }
        },
      })),
    ),
  );
}

const VARIABLES = [
  ['{count}', 'Ticket number with padding, such as 0042'],
  ['{ticket}', 'Link to the ticket channel'],
  ['{ticket.user}', 'Mention of the ticket owner'],
  ['{ticket.user.name}', 'Ticket owner’s username'],
  ['{ticket.user.nickname}', 'Ticket owner’s server nickname'],
  ['{ticket.user.id}', 'Ticket owner’s ID'],
  ['{author}', 'Mention of whoever triggered the action'],
  ['{author.name}', 'Their username'],
  ['{claim.user}', 'Who claimed the ticket'],
  ['{reason}', 'Reason given for the action'],
  ['{close.reason}', 'Reason the ticket was closed'],
  ['{delete.reason}', 'Reason the ticket was deleted'],
  ['{create.reason}', 'Reason given when the ticket was opened'],
  ['{create.form.1}', 'Answer to form question 1 (up to 5)'],
  ['{argument.1}', 'Custom command argument 1 (up to 5)'],
  ['{regex.name}', 'Named group from a regex custom command'],
  ['{server.name}', 'Server name'],
  ['{channel.name}', 'Channel name'],
  ['{panel.name}', 'Panel name'],
  ['{panel.count}', 'Tickets created in this panel'],
  ['{@Role Name}', 'Ping a role by name'],
  ['{random}', 'Random number from 0 to 100'],
  ['{random.1.6}', 'Random number in your own range'],
  ['{time}', 'Current Unix time, for <t:{time}>'],
  ['{time.created}', 'When the ticket was opened'],
  ['{time.created.age}', 'How long ago the ticket was opened'],
  ['{time.closed.age}', 'How long the ticket was open before closing'],
  ['{escalate.from}', 'Panel the ticket moved from'],
  ['{escalate.to}', 'Panel the ticket moved to'],
  ['{empty}', 'A blank value for required embed fields'],
];

function variablesView() {
  return h('div', { class: 'page' },
    h('h1', {}, 'Variables'),
    h('p', { class: 'lede' }, 'Use these in channel names and messages. They are replaced when the message is sent.'),
    h('div', { class: 'vars' }, VARIABLES.flatMap(([name, text]) => [h('code', {}, name), h('span', {}, text)])),
  );
}

const NAV = [
  ['panels', 'Panels'],
  ['server', 'Server settings'],
  ['permissions', 'Command permissions'],
  ['custom', 'Custom commands'],
  ['stats', 'Statistics'],
  ['history', 'Change history'],
  ['backup', 'Backup and restore'],
  ['variables', 'Variables'],
];

async function viewContent() {
  switch (state.view) {
    case 'server': return serverView();
    case 'permissions': return permissionsView();
    case 'custom': return customView();
    case 'stats': return statsView();
    case 'history': return historyView();
    case 'backup': return backupView();
    case 'variables': return variablesView();
    default: return panelsView();
  }
}

async function selectGuild(id) {
  state.guild = await api(`/guilds/${id}`);
  state.panelId = state.guild.panels[0]?.id ?? null;
  state.dirty = false;
  state.errors = {};
  loadDraft();
  await render();
}

function signInView(failed) {
  return h('div', { class: 'signin' },
    h('section', { class: 'stub' },
      h('div', { class: 'stub-main' },
        h('h1', {}, 'Toxtickety'),
        h('p', {}, 'Sign in with Discord to manage your server’s tickets.'),
        failed && h('p', { class: 'error-text' }, 'Discord sign-in did not finish. Try again.'),
        h('a', { class: 'btn primary', href: '/auth/login' }, 'Sign in with Discord'),
      ),
      h('div', { class: 'stub-tear', ariaHidden: 'true' }, '0001'),
    ),
  );
}

async function render() {
  state.refreshStub = null;
  document.querySelector('.savebar')?.remove();
  if (!state.me) return;

  if (state.guilds.length === 0) {
    root.replaceChildren(h('div', { class: 'signin' }, h('section', { class: 'empty' },
      h('h1', {}, 'No servers to manage'),
      h('p', {}, 'Invite the bot to a server where you are an admin, then refresh this page.'),
    )));
    return;
  }

  const serverSelect = h('select', {
    id: 'server',
    onchange: async (event) => {
      if (!confirmLeave()) { event.target.value = state.guild.id; return; }
      await selectGuild(event.target.value).catch(report);
    },
  }, state.guilds.map((guild) => h('option', { value: guild.id }, guild.name)));
  serverSelect.value = state.guild.id;

  const avatar = state.me.avatar && `https://cdn.discordapp.com/avatars/${state.me.id}/${state.me.avatar}.png?size=64`;
  const main = h('main', { class: 'main' });
  root.replaceChildren(h('div', { class: 'shell' },
    h('aside', { class: 'side' },
      h('div', { class: 'brand' }, 'Toxtickety'),
      h('div', {}, h('label', { htmlFor: 'server' }, 'Server'), serverSelect),
      h('nav', { class: 'nav', ariaLabel: 'Sections' }, NAV.map(([key, label]) => h('button', {
        type: 'button',
        textContent: label,
        'aria-current': key === state.view ? 'page' : undefined,
        onclick: () => {
          if (key === state.view || !confirmLeave()) return;
          state.view = key;
          loadDraft();
          render();
        },
      }))),
      h('div', { class: 'who' },
        avatar && h('img', { src: avatar, alt: '' }),
        h('span', {}, state.me.username),
        h('button', {
          type: 'button',
          textContent: 'Sign out',
          onclick: async () => { await api('/logout', { method: 'POST', body: {} }); location.href = '/'; },
        }),
      ),
    ),
    main,
  ));

  try {
    main.replaceChildren(await viewContent());
  } catch (error) {
    main.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'This page could not load'), h('p', {}, error.message)));
  }
  renderSaveBar();
}

async function start() {
  const failed = new URLSearchParams(location.search).has('error');
  try {
    state.me = await api('/me');
  } catch (error) {
    if (error.status === 401) { root.replaceChildren(signInView(failed)); return; }
    root.replaceChildren(h('div', { class: 'signin' }, h('p', { class: 'empty' }, error.message)));
    return;
  }
  const [schema, guilds] = await Promise.all([api('/schema'), api('/guilds')]);
  state.schema = { panel: schema.panel, guild: schema.guild };
  state.guilds = guilds;
  if (guilds.length > 0) await selectGuild(guilds[0].id);
  else await render();
}

window.addEventListener('beforeunload', (event) => {
  if (state.dirty) event.preventDefault();
});

start().catch(report);
