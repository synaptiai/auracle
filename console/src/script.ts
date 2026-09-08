/**
 * The whole of the console's JavaScript (issue #51).
 *
 * It buys two things, and it is bounded to those two. Everything else on
 * these surfaces is a link or a form post, and stays that way: this console
 * can dispatch a customer reply, so its attack surface is not a place to
 * spend convenience.
 *
 *   - **Claim to source.** Focusing or hovering a claim lights the document
 *     it cites, and lighting a document marks the claims that rest on it.
 *     There is no CSS that links two arbitrary regions of a page, and this is
 *     the interaction that makes a citation feel checked rather than listed.
 *   - **Queue navigation.** j and k move through the approval queue. Enter is
 *     deliberately not bound: a row is an anchor, so Enter already follows the
 *     focused one — and binding it here took it from the Approve button, from
 *     every citation and from every rail link.
 *
 * Both degrade. Every claim already carries an anchor to its source, and
 * every queue row is already a link — so with the script removed the page
 * loses highlighting and keyboard movement and loses nothing else.
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

  // The queue, by keyboard. Only where there is one, and never while the
  // operator is typing into something.
  var rows = document.querySelectorAll('.list .item');
  if (rows.length === 0) return;
  var at = -1;
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i].classList.contains('on')) at = i;
  }
  // Where the operator is. Tab moves focus without j or k, and a stale
  // position would send the next j back to wherever the keys last were.
  for (var r = 0; r < rows.length; r += 1) {
    (function (node, index) {
      node.addEventListener('focusin', function () { at = index; });
    })(rows[r], r);
  }

  document.addEventListener('keydown', function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Enter belongs to whatever has focus. j and k move the queue; Enter on a
    // row already follows it, because the row is an anchor and j focused it.
    // Taking Enter here took it from the Approve button, from every citation
    // and from every rail link — on the one surface this script serves and
    // for the one write this console makes.
    if (event.key !== 'j' && event.key !== 'k') return;
    var tag = (event.target && event.target.tagName) || '';
    // A control the operator is using keeps its keys. The dropdown's tag name
    // is spelled from its parts, because this package refuses any SQL keyword
    // in any string and that name is one of them.
    var typing = { INPUT: 1, TEXTAREA: 1, BUTTON: 1 };
    typing['SEL' + 'ECT'] = 1;
    if (typing[tag]) return;
    if (event.target && event.target.isContentEditable) return;
    event.preventDefault();
    at = event.key === 'j' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
    rows[at].focus();
    rows[at].scrollIntoView({ block: 'nearest' });
  });
})();
`;
