// The console's one script, run against the pages it binds to (issue #154).
//
// The script decides whether a key press sends a customer reply, so its
// behavior is tested by running it, not by reading its text. It runs in a
// Node `vm` against a document that answers each selector the script asks
// for with the elements a test placed there. A selector the test did not
// name throws, so a renamed selector fails here rather than going quiet.
//
// Its failures, written first:
//   - plain Enter in a field, or the chord on a focused link, sends;
//   - the chord sends while another outcome is open, on a held key, or twice;
//   - the chord in an editor with unsaved changes sends the old reply;
//   - a send goes out while a field on the page holds text it would drop;
//   - Enter with nothing focused takes twice, or takes with no button;
//   - a take form, or the c key, posts twice;
//   - the chord's hint names ⌘ off macOS.
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { CONSOLE_SCRIPT } from './script.js';

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
  readonly type: string;
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  target?: Element | null;
  /** The button that submitted a form, as a submit event names it. */
  submitter?: Element | null;
  defaultPrevented: boolean;
  preventDefault(): void;
}

class Element {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: Element[] = [];
  parentNode: Element | null = null;
  readonly listeners = new Map<string, Listener[]>();
  /** The form a field or button belongs to, as `element.form` reads. */
  form: Element | null = null;
  value = '';
  defaultValue = '';
  textContent = '';
  isContentEditable = false;
  /** What `submit()` and an unprevented submit event did. */
  submitted = 0;
  clicked = 0;
  /** What `querySelector` on this element answers, by selector. */
  readonly inner = new Map<string, Element | null>();

  constructor(tagName: string, attributes: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
  }

  get hidden(): boolean { return this.attributes.has('hidden'); }
  set hidden(on: boolean) { if (on) this.attributes.set('hidden', ''); else this.attributes.delete('hidden'); }
  get type(): string { return this.attributes.get('type') ?? ''; }
  set disabled(_on: boolean) { /* the undo countdown sets it; nothing here reads it */ }

  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  readonly classList = { toggle: (): void => undefined };
  focus(): void { /* focus is the event's target in these cases */ }
  scrollIntoView(): void { /* no layout here */ }

  appendChild(child: Element): Element {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  contains(other: Element | null): boolean {
    for (let at = other; at !== null; at = at.parentNode) if (at === this) return true;
    return false;
  }

  querySelector(selector: string): Element | null {
    if (!this.inner.has(selector)) throw new Error(`the script asked an element for '${selector}', which this case does not name`);
    return this.inner.get(selector) ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(event: FakeEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }

  /** A button press: click listeners first, then its form's submit unless a listener prevents it. */
  click(): void {
    this.clicked += 1;
    this.dispatch(fakeEvent('click'));
    if (this.tagName === 'BUTTON' && this.form !== null) {
      const event = fakeEvent('submit', { submitter: this });
      this.form.dispatch(event);
      if (!event.defaultPrevented) this.form.submitted += 1;
    }
  }

  /** `form.submit()` fires no submit event, as in a browser. */
  submit(): void { this.submitted += 1; }
}

function fakeEvent(type: string, extra: Partial<FakeEvent> = {}): FakeEvent {
  const event: FakeEvent = {
    type, defaultPrevented: false,
    preventDefault() { event.defaultPrevented = true; },
    ...extra,
  };
  return event;
}

/** The selectors the script asks the document for, and what each answers. */
type Page = Record<string, Element[]>;

const EVERY_SELECTOR = [
  '.claim[data-source]', '.src[data-source]', '.list .item', '.casehd a.back', '[data-undo-seconds]',
  'form[data-editor]', '[data-primary]', '[data-send]', '[data-unsaved]', '[data-typed-unsent]',
  'input[type=text], input[type=number], input[type=date], textarea',
  'form[action^="/take"]', '.kbd', 'form.takenext', '[data-batch-confirm]',
];

interface Run {
  readonly document: Element & { body: Element; listeners: Map<string, Listener[]> };
  readonly created: Element[];
  key(key: string, target: Element | null, extra?: Partial<FakeEvent>): FakeEvent;
  readonly window: { listeners: Map<string, Listener[]> };
}

function run(page: Page, options: { platform?: string; step?: Element | null } = {}): Run {
  const body = new Element('body');
  const created: Element[] = [];
  const document = Object.assign(new Element('#document'), {
    body,
    documentElement: new Element('html'),
    baseURI: 'http://console.test/',
    querySelectorAll(selector: string): Element[] {
      if (!EVERY_SELECTOR.includes(selector)) throw new Error(`the script asked for '${selector}', which this test does not name`);
      return page[selector] ?? [];
    },
    querySelector(selector: string): Element | null {
      if (!EVERY_SELECTOR.includes(selector)) throw new Error(`the script asked for '${selector}', which this test does not name`);
      return page[selector]?.[0] ?? null;
    },
    getElementById(id: string): Element | null {
      if (id !== 'step') throw new Error(`the script asked for #${id}, which this test does not name`);
      return options.step ?? null;
    },
    createElement(tag: string): Element {
      const element = new Element(tag);
      created.push(element);
      return element;
    },
  });
  const window = {
    listeners: new Map<string, Listener[]>(),
    addEventListener(type: string, listener: Listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    },
    location: { origin: 'http://console.test', search: '', href: 'http://console.test/' },
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
  runInNewContext(CONSOLE_SCRIPT, {
    document, window, URL, navigator: { platform: options.platform ?? 'MacIntel' },
  });
  return {
    document, created, window,
    key(key, target, extra = {}) {
      const event = fakeEvent('keydown', { key, target: target ?? body, ...extra });
      document.dispatch(event);
      return event;
    },
  };
}

/** A case page where the ledger holds the reply: the send, its form, and the editor. */
function casePage(typedElsewhere = false, chord = true) {
  // The send button posts the editor's form (SEC-3), so its text reaches the
  // approval. It sits in the bar, outside the form it names.
  const editor = new Element('form', { 'data-editor': '' });
  const sendForm = editor;
  const send = new Element('button', { type: 'submit', 'data-send': '', form: 'reply-editor' });
  if (chord) send.setAttribute('data-primary', '');
  send.form = editor;
  const save = new Element('button', { type: 'submit' });
  save.form = editor;
  editor.appendChild(save);
  const reply = new Element('textarea');
  reply.form = editor;
  reply.value = 'Thanks for writing in.';
  reply.defaultValue = 'Thanks for writing in.';
  editor.appendChild(reply);
  editor.inner.set('textarea', reply);
  // A field of another form: a close reason, a missing answer, a document title.
  const otherForm = new Element('form', { action: '/close' });
  const reason = new Element('input', { type: 'text' });
  reason.form = otherForm;
  otherForm.appendChild(reason);
  if (typedElsewhere) reason.value = 'the customer wrote again';
  const unsavedNote = new Element('p', { 'data-unsaved': '', hidden: '' });
  const typedNote = new Element('p', { 'data-typed-unsent': '', hidden: '' });
  const link = new Element('a', { class: 'cite', href: '/document/SYN-DOC-01' });
  const kbd = new Element('span', { class: 'kbd' });
  kbd.textContent = '⌘↵';
  const page: Page = {
    'form[data-editor]': [editor],
    '[data-primary]': chord ? [send] : [],
    '[data-send]': [send],
    '[data-unsaved]': [unsavedNote],
    '[data-typed-unsent]': [typedNote],
    'input[type=text], input[type=number], input[type=date], textarea': [reply, reason],
    '.kbd': [kbd],
  };
  return { page, send, save, sendForm, editor, reply, reason, unsavedNote, typedNote, link, kbd };
}

describe('the send chord on a case', () => {
  it('presses the send once from the page, and never a second time', () => {
    const c = casePage();
    const page = run(c.page);
    expect(page.key('Enter', null, { metaKey: true }).defaultPrevented).toBe(true);
    page.key('Enter', null, { metaKey: true });
    // The second press reaches the send, and its guard posts nothing more.
    expect(c.sendForm.submitted).toBe(1);
  });

  it('answers Ctrl+Enter as it answers Cmd+Enter', () => {
    const c = casePage();
    run(c.page).key('Enter', null, { ctrlKey: true });
    expect(c.sendForm.submitted).toBe(1);
  });

  it('sends nothing on plain Enter, with Shift or Alt, or on a held key', () => {
    const c = casePage();
    const page = run(c.page);
    page.key('Enter', c.reply);
    page.key('Enter', null, { metaKey: true, shiftKey: true });
    page.key('Enter', null, { metaKey: true, altKey: true });
    page.key('Enter', null, { metaKey: true, repeat: true });
    expect(c.send.clicked).toBe(0);
    expect(c.editor.submitted).toBe(0);
  });

  it('leaves a focused link its own chord', () => {
    const c = casePage();
    const event = run(c.page).key('Enter', c.link, { metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(c.send.clicked).toBe(0);
  });

  it('sends nothing while another outcome is open', () => {
    const c = casePage();
    run(c.page, { step: new Element('div', { id: 'step' }) }).key('Enter', null, { metaKey: true });
    expect(c.send.clicked).toBe(0);
  });

  it('leaves a field of another form its own Enter, empty or typed in', () => {
    const c = casePage();
    run(c.page).key('Enter', c.reason, { metaKey: true });
    expect(c.send.clicked).toBe(0);
    const typed = casePage(true);
    const event = run(typed.page).key('Enter', typed.reason, { metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(typed.typedNote.hidden).toBe(true);
    expect(typed.send.clicked).toBe(0);
  });

  it('presses the focused send, not the bar\'s', () => {
    const c = casePage();
    const copyForm = new Element('form', { action: '/edit' });
    const copySend = new Element('button', { type: 'submit', 'data-send': '' });
    copySend.form = copyForm;
    copyForm.appendChild(copySend);
    c.page['[data-send]'] = [c.send, copySend];
    run(c.page).key('Enter', copySend, { metaKey: true });
    expect(copyForm.submitted).toBe(1);
    expect(c.send.clicked).toBe(0);
  });

  it('presses the send when the send itself has focus', () => {
    const c = casePage();
    run(c.page).key('Enter', c.send, { metaKey: true });
    expect(c.sendForm.submitted).toBe(1);
  });

  it('saves a changed editor once, and sends nothing', () => {
    const c = casePage();
    c.reply.value = 'Thanks for writing in. We refunded it.';
    const page = run(c.page);
    page.key('Enter', c.reply, { metaKey: true });
    page.key('Enter', null, { metaKey: true });
    expect(c.editor.submitted).toBe(1);
    expect(c.send.clicked).toBe(0);
  });

  it('sends nothing while a field on the page holds typed text, and says why', () => {
    const c = casePage(true);
    run(c.page).key('Enter', null, { metaKey: true });
    expect(c.send.clicked).toBe(0);
    expect(c.typedNote.hidden).toBe(false);
  });

  it('names Ctrl+Enter on the button off macOS, and keeps ⌘ on it', () => {
    const off = casePage();
    run(off.page, { platform: 'Win32' });
    expect(off.kbd.textContent).toBe('Ctrl+Enter');
    const mac = casePage();
    run(mac.page, { platform: 'MacIntel' });
    expect(mac.kbd.textContent).toBe('⌘↵');
  });
});

describe('a send pressed by hand', () => {
  it('stops a send that would drop the editor\'s unsaved changes, and says why', () => {
    const c = casePage();
    c.reply.value = 'Thanks for writing in. We refunded it.';
    run(c.page);
    c.send.click();
    expect(c.sendForm.submitted).toBe(0);
    expect(c.unsavedNote.hidden).toBe(false);
  });

  it('stops a send that would drop text typed in another form, and says why', () => {
    const c = casePage(true);
    run(c.page);
    c.send.click();
    expect(c.sendForm.submitted).toBe(0);
    expect(c.typedNote.hidden).toBe(false);
    expect(c.unsavedNote.hidden).toBe(true);
  });

  it('lets the editor\'s own Save post its changes', () => {
    const c = casePage();
    c.reply.value = 'Thanks for writing in. We refunded it.';
    run(c.page);
    c.save.click();
    expect(c.editor.submitted).toBe(1);
    expect(c.unsavedNote.hidden).toBe(true);
  });

  // ERR-3: a case someone else holds draws its send with no chord. The send
  // is still guarded, and the chord presses nothing.
  it('guards a send that carries no chord, and presses nothing by key', () => {
    const typed = casePage(true, false);
    const page = run(typed.page);
    page.key('Enter', null, { metaKey: true });
    expect(typed.send.clicked).toBe(0);
    typed.send.click();
    expect(typed.sendForm.submitted).toBe(0);
    expect(typed.typedNote.hidden).toBe(false);
  });

  it('posts a send once, however often it is pressed', () => {
    const c = casePage();
    const page = run(c.page);
    c.send.click();
    c.send.click();
    page.key('Enter', null, { metaKey: true });
    expect(c.sendForm.submitted).toBe(1);
  });

  // A browser older than SubmitEvent.submitter names no submitter. The
  // editor's Save must still post its changes there.
  it('lets a submit no send armed through, in a browser that names no submitter', () => {
    const c = casePage();
    c.reply.value = 'Thanks for writing in. We refunded it.';
    run(c.page);
    const event = fakeEvent('submit');
    c.editor.dispatch(event);
    expect(event.defaultPrevented).toBe(false);
  });

  // A refused send returns the reviewer by Back, to a page the browser
  // restores with its variables. That page sends again.
  it('lets a page the browser restores from its back cache send again', () => {
    const c = casePage();
    const page = run(c.page);
    c.send.click();
    for (const listener of page.window.listeners.get('pageshow') ?? []) listener(fakeEvent('pageshow'));
    c.send.click();
    expect(c.sendForm.submitted).toBe(2);
  });

  it('sends when nothing typed would be dropped', () => {
    const c = casePage();
    run(c.page);
    c.send.click();
    expect(c.sendForm.submitted).toBe(1);
  });
});

describe('taking a case by key or by button', () => {
  function queuePage() {
    const takeNext = new Element('form', { action: '/take', class: 'takenext' });
    const rowTake = new Element('form', { action: '/take' });
    const row = new Element('a', { class: 'item', href: '/case/11111111-1111-4111-8111-111111111111' });
    const page: Page = {
      'form.takenext': [takeNext],
      'form[action^="/take"]': [takeNext, rowTake],
      '.list .item': [row],
    };
    return { page, takeNext, rowTake, row };
  }

  it('takes the next case once on Enter with nothing focused', () => {
    const q = queuePage();
    const page = run(q.page);
    page.key('Enter', null);
    page.key('Enter', null);
    expect(q.takeNext.submitted).toBe(1);
  });

  it('leaves Enter on a focused row, or on a page with no take next, alone', () => {
    const q = queuePage();
    run(q.page).key('Enter', q.row);
    expect(q.takeNext.submitted).toBe(0);
    const empty = run({});
    expect(empty.key('Enter', null).defaultPrevented).toBe(false);
  });

  it('posts a take form once, however often it is pressed', () => {
    const q = queuePage();
    run(q.page);
    const first = fakeEvent('submit');
    const second = fakeEvent('submit');
    q.rowTake.dispatch(first);
    q.rowTake.dispatch(second);
    expect(first.defaultPrevented).toBe(false);
    expect(second.defaultPrevented).toBe(true);
  });

  it('takes the focused row once on c, and ignores a held c', () => {
    const q = queuePage();
    const page = run(q.page);
    q.row.dispatch(fakeEvent('focusin'));
    page.key('c', q.row, { repeat: true });
    page.key('c', q.row);
    page.key('c', q.row);
    const forms = page.created.filter((element) => element.tagName === 'FORM');
    expect(forms).toHaveLength(1);
    expect(forms[0]!.submitted).toBe(1);
    expect(forms[0]!.getAttribute('action') ?? (forms[0] as unknown as { action: string }).action).toBe('/take');
  });

  it('lets a page the browser restores from its back cache press again', () => {
    const q = queuePage();
    const page = run(q.page);
    page.key('Enter', null);
    for (const listener of page.window.listeners.get('pageshow') ?? []) listener(fakeEvent('pageshow'));
    page.key('Enter', null);
    expect(q.takeNext.submitted).toBe(2);
  });
});
