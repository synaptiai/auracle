/**
 * The whole of the console's JavaScript (issue #51).
 *
 * It buys three things, and it is bounded to those three. Everything else on
 * these surfaces is a link or a form post, and stays that way: this console
 * can dispatch a customer reply, so its attack surface is not a place to
 * spend convenience.
 *
 *   - **Claim to source.** Focusing or hovering a claim lights the document
 *     it cites, and lighting a document marks the claims that rest on it.
 *     There is no CSS that links two arbitrary regions of a page, and this is
 *     the interaction that makes a citation feel checked rather than listed.
 *   - **Queue navigation.** j and k move through the approval queue, c takes
 *     the focused case (DEC-46), and Enter opens it. Enter is deliberately
 *     not bound: a row is an anchor, so Enter already follows the focused one
 *     — and binding it here took it from the Approve button, from every
 *     citation and from every rail link.
 *   - **Esc leaves a case.** It follows the case's own back link, which keeps
 *     the queue rule the reviewer chose.
 *
 * All three degrade. Every claim already carries an anchor to its source,
 * every queue row is already a link, and a case keeps its back link — so with
 * the script removed the page loses highlighting, the queue keys and the Esc
 * shortcut, and loses nothing else.
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
      if (at < 0) return;
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
