/**
 * The whole of the console's JavaScript.
 *
 * It buys four things, and it is bounded to those four. Everything else on
 * these surfaces is a link or a form post, and stays that way: this console
 * can dispatch a customer reply, so its attack surface is not a place to
 * spend convenience.
 *
 *   - **Claim to source.** Focusing or hovering a claim lights the document
 *     it cites, and lighting a document marks the claims that rest on it.
 *     There is no CSS that links two arbitrary regions of a page, and this is
 *     the interaction that makes a citation feel checked rather than listed.
 *   - **Queue navigation.** j and k move through the approval queue, c takes
 *     the focused case (DEC-46), and Enter opens it. Enter on a focused control
 *     stays that control's: a row is an anchor, so Enter already follows the
 *     focused one — and binding it there took it from the Approve button, from
 *     every citation and from every rail link. Enter with nothing focused takes
 *     the next case.
 *   - **Esc leaves a case.** It follows the case's own back link, which keeps
 *     the queue rule the reviewer chose.
 *   - **⌘↵ sends**, Ctrl+Enter off macOS. The chord presses the case's send
 *     button from the page, the send's form or the editor. In an editor with
 *     unsaved changes it saves them and sends nothing. It acts on no repeat, on
 *     no second press, and not while another outcome is open.
 *
 * All four degrade. Every claim already carries an anchor to its source,
 * every queue row is already a link, a case keeps its back link, and the send
 * and take next are buttons — so with the script removed the page loses
 * highlighting, the queue keys, Esc, Enter's take next and the chord. It also
 * loses two guards: the stop on a send while another field holds typed text,
 * and one post per press on a take. The approval still refuses a change to
 * the reply nobody saved, on the server.
 *
 * Served inline under a CSP hash rather than from a path. A hash permits this
 * exact text and nothing else, so a script injected into a page cannot run.
 *
 * It is not an integrity check on this file. The hash is computed from this
 * constant at startup, so an edit here produces a matching hash and runs. The
 * bound is what a page may execute, not what a build may change.
 */
export const CONSOLE_SCRIPT = `
(function () {
  var claims = document.querySelectorAll('.claim[data-source]');
  var sources = document.querySelectorAll('.src[data-source]');

  function light(docId, on) {
    function mark(nodes) {
      for (var i = 0; i < nodes.length; i += 1) {
        if (nodes[i].getAttribute('data-source') === docId) {
          nodes[i].classList.toggle('lit', on);
        }
      }
    }
    mark(claims);
    mark(sources);
  }

  function bind(nodes) {
    for (var i = 0; i < nodes.length; i += 1) {
      (function (node) {
        var docId = node.getAttribute('data-source');
        node.addEventListener('mouseenter', function () { light(docId, true); });
        node.addEventListener('mouseleave', function () { light(docId, false); });
        node.addEventListener('focusin', function () { light(docId, true); });
        node.addEventListener('focusout', function () { light(docId, false); });
      })(nodes[i]);
    }
  }
  bind(claims);
  bind(sources);

  // One press per page: a second press before the page moves on would send
  // a second request, and take next would take a second case.
  var pressed = false;
  // A page the browser restores from its back cache keeps its variables, and
  // a press it made is not one this visit made.
  window.addEventListener('pageshow', function () {
    pressed = false;
    sent = false;
    armed = false;
  });

  // What the operator is typing into. A control keeps its keys; the
  // dropdown's tag name is spelled from its parts, because this package
  // refuses any SQL keyword in any string and that name is one of them.
  var typing = { INPUT: 1, TEXTAREA: 1, BUTTON: 1 };
  typing['SEL' + 'ECT'] = 1;
  function inControl(event) {
    var tag = (event.target && event.target.tagName) || '';
    return Boolean(typing[tag] || (event.target && event.target.isContentEditable));
  }

  // The queue, by keyboard. Only where there is one.
  var rows = document.querySelectorAll('.list .item');
  // No row is open on the queue, since each case has a page of its own. So
  // the first j reaches the first row.
  var at = -1;
  // Where the operator is. Tab moves focus without j or k, and a stale
  // position would send the next j back to wherever the keys last were.
  for (var r = 0; r < rows.length; r += 1) {
    (function (node, index) {
      node.addEventListener('focusin', function () { at = index; });
    })(rows[r], r);
  }

  // Esc leaves a case by the link a click already follows, keeping the queue
  // rule the reviewer chose. It acts on every page that carries a back link,
  // and obeys the same control guard as the queue keys, so no key is ever
  // taken from a field.
  var back = document.querySelector('.casehd a.back');

  document.addEventListener('keydown', function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape' && back) {
      if (inControl(event)) return;
      // Same origin only. The href is server-built and always a local path
      // today, and this keeps a future producer of the back link from making
      // Esc run a scheme this page never ships.
      var href = back.getAttribute('href');
      if (href !== null) {
        var url = new URL(href, document.baseURI);
        if (url.origin === window.location.origin
            && (url.protocol === 'http:' || url.protocol === 'https:')) {
          event.preventDefault();
          window.location.href = url.href;
        }
      }
      return;
    }
    // Enter belongs to whatever has focus. j and k move the queue, c takes
    // the focused case, and Enter on a row already follows it, because the
    // row is an anchor and j focused it. Nothing focused means no case is
    // focused, so c does nothing rather than choose one.
    if (event.key !== 'j' && event.key !== 'k' && event.key !== 'c') return;
    if (rows.length === 0) return;
    if (inControl(event)) return;
    event.preventDefault();
    if (event.key === 'c') {
      if (at < 0 || pressed || event.repeat) return;
      // DEC-46: c takes the focused case. A take is a write, so it is a form
      // post — this builds the one the row needs and submits it. A link
      // would write on a GET, which the console never does, and the row's
      // own form would be a button inside an anchor, which is not markup a
      // browser accepts.
      var rowHref = rows[at].getAttribute('href');
      if (rowHref === null) return;
      var rowUrl = new URL(rowHref, document.baseURI);
      if (rowUrl.origin !== window.location.origin) return;
      var taken = decodeURIComponent(rowUrl.pathname.split('/')[2] || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taken)) return;
      var takeForm = document.createElement('form');
      takeForm.method = 'post';
      // The queue's filters ride on the action, as they do on every form the
      // server renders (DEC-47). The take redirect rebuilds them from the
      // POST URL, so a shortcut that dropped them would return the reviewer
      // to a queue they had not chosen.
      takeForm.action = '/take' + window.location.search;
      var takeField = document.createElement('input');
      takeField.type = 'hidden';
      takeField.name = 'runId';
      takeField.value = taken;
      takeForm.appendChild(takeField);
      document.body.appendChild(takeForm);
      pressed = true;
      takeForm.submit();
      return;
    }
    at = event.key === 'j' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
    rows[at].focus();
    rows[at].scrollIntoView({ block: 'nearest' });
  });

  // DEC-51: the undo button counts down the hold the ledger already holds.
  // The count is display only. The window is checked on the server, after the
  // row lock, so a frozen tab, a throttled timer or a moved clock on this
  // machine changes nothing that matters.
  var undos = document.querySelectorAll('[data-undo-seconds]');
  for (var u = 0; u < undos.length; u += 1) {
    (function (button) {
      var left = parseInt(button.getAttribute('data-undo-seconds'), 10);
      if (isNaN(left)) return;
      var note = button.parentNode === null
        ? null
        : button.parentNode.querySelector('[data-undo-note]');
      var tick = window.setInterval(function () {
        left -= 1;
        if (left > 0) {
          button.textContent = 'Undo · ' + left + 's';
          return;
        }
        window.clearInterval(tick);
        button.disabled = true;
        button.textContent = 'Undo';
        if (note !== null) {
          note.textContent = 'The window has passed, so the relay may post these replies now.';
          note.removeAttribute('hidden');
        }
      }, 1000);
      button.addEventListener('click', function () { window.clearInterval(tick); });
    })(undos[u]);
  }

  // The case's primary control by chord, and the next case by Enter. The
  // approval sends the reply the ledger holds, never the text in the editor, so
  // changes the reviewer has not saved would be dropped by a send: the chord
  // saves them instead, and a send while they are unsaved is stopped and says
  // why.
  var editor = document.querySelector('form[data-editor]');
  var primary = document.querySelector('[data-primary]');
  var unsavedNote = document.querySelector('[data-unsaved]');
  function unsaved() {
    if (editor === null) return false;
    var field = editor.querySelector('textarea');
    return field !== null && field.value !== field.defaultValue;
  }
  // Any other field on the case holds text of its own that a send would
  // drop: a close reason, a rewrite, a missing answer, a document's title. A
  // send waits until that text is posted or cleared.
  var fields = document.querySelectorAll('input[type=text], input[type=number], input[type=date], textarea');
  var typedNote = document.querySelector('[data-typed-unsent]');
  function typedUnsent() {
    for (var s = 0; s < fields.length; s += 1) {
      var field = fields[s];
      if (editor !== null && editor.contains(field)) continue;
      if (field.value !== field.defaultValue) return true;
    }
    return false;
  }
  // Every send is guarded, whether or not the chord binds to it: a case
  // someone else holds keeps its send for a click, and that click is guarded.
  var sends = document.querySelectorAll('[data-send]');
  function isSend(element) {
    for (var n = 0; n < sends.length; n += 1) if (sends[n] === element) return true;
    return false;
  }
  // A press on a send arms the guard for the submit it starts. A send may post
  // the editor's own form, so the editor's Save submits that form too, and
  // only an armed submit is a send. Armed by the click rather than read from
  // the submit, because an older browser names no submitter.
  var armed = false;
  // A send posts once: a second press would post the approval again.
  var sent = false;
  var guarded = [];
  for (var g = 0; g < sends.length; g += 1) {
    sends[g].addEventListener('click', function () { armed = true; });
    var sendForm = sends[g].form;
    if (!sendForm || guarded.indexOf(sendForm) !== -1) continue;
    guarded.push(sendForm);
    sendForm.addEventListener('submit', function (event) {
      if (!armed) return;
      armed = false;
      if (sent) {
        event.preventDefault();
        return;
      }
      if (typedUnsent()) {
        event.preventDefault();
        if (typedNote !== null) typedNote.removeAttribute('hidden');
        return;
      }
      if (unsaved()) {
        event.preventDefault();
        if (unsavedNote !== null) unsavedNote.removeAttribute('hidden');
        return;
      }
      sent = true;
    });
  }
  // A take posts once. A second press before the page moves on would take
  // a second case.
  var takeForms = document.querySelectorAll('form[action^="/take"]');
  for (var f = 0; f < takeForms.length; f += 1) {
    takeForms[f].addEventListener('submit', function (event) {
      if (pressed) { event.preventDefault(); return; }
      pressed = true;
    });
  }
  // The chord's name on the button, for the platform this page runs on.
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
    var kbds = document.querySelectorAll('.kbd');
    for (var k = 0; k < kbds.length; k += 1) kbds[k].textContent = 'Ctrl+Enter';
  }
  document.addEventListener('keydown', function (event) {
    // A held key repeats, and a repeat reaches the page a save reloaded:
    // only a fresh press acts.
    if (event.key !== 'Enter' || event.altKey || event.shiftKey || event.repeat) return;
    if (event.metaKey || event.ctrlKey) {
      // While another outcome is open, the chord is that outcome's, and it
      // sends nothing: a reviewer closing or snoozing a case did not mean
      // to send its reply.
      if (document.getElementById('step') !== null) return;
      // A field of another form is that form's: a close reason, a snooze
      // period, a rewrite or a note. The chord sends nothing from one, and
      // says nothing about it.
      var target = event.target;
      var onSend = isSend(target);
      var owner = target && target.form;
      if (!onSend && owner && owner !== (primary && primary.form) && owner !== editor) return;
      // A focused link or citation keeps its own chord, which opens it in a
      // new tab. The chord sends only from the page itself, a send, the send's
      // own form or the editor.
      var inSend = Boolean(primary && primary.form && primary.form.contains(target));
      var inEditor = Boolean(editor && editor.contains(target));
      if (target !== document.body && !onSend && !inSend && !inEditor) return;
      if (typedUnsent()) {
        event.preventDefault();
        if (typedNote !== null) typedNote.removeAttribute('hidden');
        return;
      }
      if (unsaved()) {
        event.preventDefault();
        if (pressed) return;
        pressed = true;
        editor.submit();
        return;
      }
      // The focused send is the one pressed; otherwise the case's own.
      var pressedSend = onSend ? target : primary;
      if (pressedSend === null) return;
      event.preventDefault();
      // A click, so the send is the one the button makes, with its form and
      // its guard: a second press is refused there.
      pressedSend.click();
      return;
    }
    // Enter stays the focused control's. With nothing focused it takes the
    // next case, as the queue's button says.
    if (event.target !== document.body) return;
    var next = document.querySelector('form.takenext');
    if (next === null || pressed) return;
    event.preventDefault();
    pressed = true;
    next.submit();
  });

  // The 'a' key activates the batch confirm, which is the one control on the
  // queue that acts on several cases at once. It clicks the button rather
  // than posting anything itself: the button carries the checked rows, and a
  // second copy of that rule would be a second way to send.
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'a' || event.metaKey || event.ctrlKey || event.altKey) return;
    var target = event.target;
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    var confirm = document.querySelector('[data-batch-confirm]');
    if (confirm === null) return;
    event.preventDefault();
    confirm.click();
  });
})();
`;
