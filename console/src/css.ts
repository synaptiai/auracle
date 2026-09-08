// The console's stylesheet, as a module (issue #27).
//
// A `.css` file beside the source does not survive the build: `tsc` emits
// JavaScript and nothing else, and there is no copy step — so the console
// started, failed to read its own stylesheet and exited. Keeping the styles
// in a module makes `tsc` the whole build and removes the failure mode.
//
// The design's `@import` of Google Fonts is dropped. An operator console
// handling customer-support data should make no third-party request per page
// view, and the declarations already name a `system-ui` and `ui-monospace`
// fallback. It also has to work on a host with no egress.
//
// Everything below the tokens comes from `.creatumo/design/console-canvas/`.
// The canvas holds five artboards and each carries its own `<style>` block, so
// joining them into one stylesheet meant resolving four collisions. A
// concatenation would have let the last artboard read win, silently:
//
//   - `.shell` is a 188px rail beside the main column on Main, and a 300px
//     queue beside a detail pane on Approvals. The rail is the shell every
//     surface shares, so the queue became `.split` inside it.
//   - `.gate` is a 44px bar in a Main table cell and a bordered card on Run
//     detail. The runs table shows no gate, so only the card survives.
//   - `.track` is a 6px bar carrying threshold markers on Run detail and a
//     5px fill on Latency. Both are kept, scoped to the block that owns them.
//   - `.big` is 27px on Run detail and 29px on Bands. One size, because the
//     two never appear on one page and the difference is not a distinction.
//
// No rule here is unreachable. The light palette is reached by the theme
// toggle in `server.ts`, which sets `data-theme` on the root through a cookie.
export const CONSOLE_CSS = `
body { margin: 0; }
.root {
  --bg:#0d0e10; --panel:#141619; --panel2:#1a1d21; --ink:#e6e7e8; --mut:#878d95;
  --dim:#5b626a; --rule:#25292e; --rule2:#31363c;
  --accent:oklch(0.66 0.11 255); --warn:oklch(0.72 0.11 78); --hot:oklch(0.66 0.13 42);
  --crit:oklch(0.62 0.15 22); --ok:oklch(0.68 0.09 155);
  font-family:'IBM Plex Sans',system-ui,sans-serif; background:var(--bg); color:var(--ink);
  font-size:13px; line-height:1.45; min-height:100vh; box-sizing:border-box;
  -webkit-font-smoothing:antialiased;
}
.root[data-theme="light"] {
  --bg:#f7f7f5; --panel:#ffffff; --panel2:#f1f1ee; --ink:#17181a; --mut:#5f656c;
  --dim:#9198a0; --rule:#e4e4e0; --rule2:#d3d3ce;
  --accent:oklch(0.52 0.12 255); --warn:oklch(0.58 0.11 78); --hot:oklch(0.55 0.14 42);
  --crit:oklch(0.52 0.16 22); --ok:oklch(0.52 0.10 155);
}
.root *, .root *::before, .root *::after { box-sizing:border-box; }
.m { font-family:'IBM Plex Mono',ui-monospace,monospace; font-variant-numeric:tabular-nums; }
a { color:var(--accent); text-decoration:none; }
a:hover { color:var(--ink); text-decoration:underline; }
.lbl { font-size:10px; letter-spacing:.09em; text-transform:uppercase; color:var(--dim); font-weight:500; }
.chip { display:inline-flex; align-items:center; gap:5px; padding:2px 7px; border:1px solid var(--rule2);
  border-radius:3px; font-size:11px; font-family:'IBM Plex Mono',ui-monospace,monospace; color:var(--mut); }
.dot { width:6px; height:6px; border-radius:50%; background:currentColor; flex:none; }
.mut { color:var(--mut); }

/* The shell: a fixed rail beside one scrolling column. */
.shell { display:grid; grid-template-columns:188px 1fr; min-height:100vh; }
/* Sticky, and the artboard is why. The canvas draws a fixed-height board, so
   its rail sits beside the content by construction. A real runs page is 200
   rows long, and a rail that scrolls with them takes the navigation and the
   theme toggle off the screen at the first scroll. */
.rail { background:var(--panel); border-right:1px solid var(--rule); display:flex;
  flex-direction:column; position:sticky; top:0; height:100vh; overflow:auto; }
.brand { padding:16px 18px 14px; border-bottom:1px solid var(--rule); }
.nav { display:flex; flex-direction:column; padding:10px 8px; gap:1px; }
.nav a { display:flex; align-items:center; justify-content:space-between; padding:7px 10px;
  border-radius:4px; color:var(--mut); font-size:13px; }
.nav a:hover { background:var(--panel2); color:var(--ink); text-decoration:none; }
.nav a.on { background:var(--panel2); color:var(--ink); box-shadow:inset 2px 0 0 var(--accent); }
.badge { font-family:'IBM Plex Mono',ui-monospace,monospace; font-size:11px; padding:1px 6px;
  border-radius:9px; background:var(--warn); color:#14161a; font-weight:600; }
.railfoot { margin-top:auto; padding:14px 18px; border-top:1px solid var(--rule);
  display:flex; flex-direction:column; gap:7px; align-items:flex-start; }
/* The rail is 188px and a ledger name is as long as its host. Left to the
   chip's own rules the name ran under the border and read as a different
   database: localhost:5433/auracle clipped to localhost:5433/aurac. */
.railfoot .chip { max-width:100%; overflow-wrap:anywhere; }
.main { display:flex; flex-direction:column; min-width:0; }
.top { display:flex; align-items:center; justify-content:space-between; gap:16px;
  padding:12px 20px; border-bottom:1px solid var(--rule); background:var(--panel); }
.filters { display:flex; align-items:center; gap:8px; padding:11px 20px;
  border-bottom:1px solid var(--rule); flex-wrap:wrap; }
.seg { display:flex; border:1px solid var(--rule2); border-radius:4px; overflow:hidden; }
.seg a { padding:4px 10px; font-size:11px; font-family:'IBM Plex Mono',ui-monospace,monospace;
  color:var(--mut); border-right:1px solid var(--rule2); }
.seg a:last-child { border-right:0; }
.seg a:hover { background:var(--panel2); color:var(--ink); text-decoration:none; }
.seg a.on { background:var(--accent); color:#0d0e10; }
.foot { margin-top:auto; padding:10px 20px; border-top:1px solid var(--rule); display:flex;
  justify-content:space-between; align-items:center; gap:14px; color:var(--dim); font-size:11px;
  flex-wrap:wrap; }

/* A surface that is not a table lays its blocks out here. */
.wrap { padding:20px 24px 28px; display:flex; flex-direction:column; gap:16px; }
.hd { display:flex; align-items:flex-start; justify-content:space-between; gap:20px;
  padding-bottom:14px; border-bottom:1px solid var(--rule); flex-wrap:wrap; }
.hdt { font-size:16px; font-weight:600; }
.hds { color:var(--mut); font-size:12px; margin-top:4px; max-width:78ch; }
.card { background:var(--panel); border:1px solid var(--rule); border-radius:5px; }
.card > header { padding:10px 14px; border-bottom:1px solid var(--rule); display:flex;
  align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.card > .body { padding:14px; }
.card.stack > .body { display:flex; flex-direction:column; gap:12px; }
.kv { display:grid; grid-template-columns:auto auto; gap:3px 14px; font-size:11px; margin:0; }
.kv dt { color:var(--dim); font-family:'IBM Plex Mono',ui-monospace,monospace; }
.kv dd { margin:0; font-family:'IBM Plex Mono',ui-monospace,monospace; color:var(--mut); }
.big { font-family:'IBM Plex Mono',ui-monospace,monospace; font-size:27px; font-weight:500;
  letter-spacing:-.02em; font-variant-numeric:tabular-nums; line-height:1; }
.discl { border-left:2px solid var(--warn); padding:9px 12px; background:var(--panel2);
  font-size:11.5px; color:var(--mut); }
.note { display:flex; gap:9px; align-items:flex-start; padding:12px 15px; background:var(--panel);
  border:1px solid var(--rule); border-left:2px solid var(--accent); border-radius:5px;
  font-size:11.5px; color:var(--mut); }

/* The runs table. */
table { width:100%; border-collapse:collapse; }
thead th { text-align:left; font-size:10px; letter-spacing:.09em; text-transform:uppercase;
  color:var(--dim); font-weight:500; padding:9px 12px; border-bottom:1px solid var(--rule2);
  position:sticky; top:0; background:var(--bg); }
tbody td { padding:8px 12px; border-bottom:1px solid var(--rule); font-size:12px; vertical-align:middle; }
tbody tr:hover { background:var(--panel); }
.st { display:inline-flex; align-items:center; gap:6px;
  font-family:'IBM Plex Mono',ui-monospace,monospace; font-size:11px; }

/* Run detail: the step journal, the two gates, the retrieved evidence. */
.cols { display:grid; grid-template-columns:326px 1fr; gap:16px; align-items:start; }
.tl { display:flex; flex-direction:column; }
.step { display:grid; grid-template-columns:14px 1fr; gap:11px; padding:0 0 2px; }
.spine { display:flex; flex-direction:column; align-items:center; }
.spine .k { width:9px; height:9px; border-radius:50%; border:2px solid var(--bg); margin-top:4px; flex:none; }
.spine .l { width:1px; flex:1; background:var(--rule2); min-height:20px; }
.step:last-child .spine .l { background:transparent; }
.stepbody { padding-bottom:14px; }
.steptop { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
.gates { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.gate { border:1px solid var(--rule2); border-radius:4px; padding:13px; display:flex;
  flex-direction:column; gap:10px; }
.gate .track { height:6px; border-radius:3px; background:var(--rule2); position:relative; }
.gate .track i { position:absolute; inset:0 auto 0 0; border-radius:3px; }
.gate .track b { position:absolute; top:-4px; bottom:-4px; width:2px; background:var(--ink); }
.ev { display:grid; grid-template-columns:26px minmax(0,1fr) 132px 116px; gap:12px; align-items:center;
  padding:8px 0; border-bottom:1px solid var(--rule); font-size:12px; }
.ev:last-child { border-bottom:0; }

/* The approval queue: the waiting list beside the run it is showing. */
.split { display:grid; grid-template-columns:300px 1fr; min-height:0; flex:1; }
.list { border-right:1px solid var(--rule); background:var(--panel); display:flex;
  flex-direction:column; }
.lhd { padding:14px 16px; border-bottom:1px solid var(--rule); }
.item { display:block; padding:12px 16px; border-bottom:1px solid var(--rule); color:inherit; }
.item:hover { background:var(--panel2); text-decoration:none; color:inherit; }
.item.on { background:var(--panel2); box-shadow:inset 2px 0 0 var(--accent); }
.pane { padding:20px 26px 24px; display:flex; flex-direction:column; gap:15px; }
.btn { padding:8px 18px; border-radius:4px; font-size:12.5px; font-weight:600;
  border:1px solid transparent; font-family:'IBM Plex Sans',system-ui,sans-serif; cursor:pointer; }
.primary { background:var(--ok); color:#0d0e10; }
.warnbar { display:flex; gap:9px; align-items:flex-start; border:1px solid var(--rule2);
  border-left:2px solid var(--accent); border-radius:4px; padding:11px 13px; background:var(--panel); }
.outcome { border:1px solid var(--rule2); border-left:2px solid var(--accent); border-radius:4px;
  padding:11px 13px; background:var(--panel); font-size:12px; margin:0; }

/* Control bands: one card for each metric, and the legend the actions come from. */
.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:14px; }
.verdict { display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border-radius:3px;
  font-size:11px; font-family:'IBM Plex Mono',ui-monospace,monospace; font-weight:500; }
.legend { display:flex; gap:20px; flex-wrap:wrap; padding:12px 15px; background:var(--panel);
  border:1px solid var(--rule); border-radius:5px; }
.lg { display:flex; gap:8px; align-items:flex-start; }
.shortfall { border:1px dashed var(--rule2); border-radius:4px; padding:16px 14px;
  display:flex; flex-direction:column; gap:5px; align-items:flex-start; }
.spark { width:100%; height:96px; overflow:visible; }

/* Partition latency: one row for each partition, percentiles beside each other. */
.row { display:grid; grid-template-columns:56px 1fr 1fr 132px; gap:18px; align-items:center;
  padding:11px 15px; border-bottom:1px solid var(--rule); }
.row:last-child { border-bottom:0; }
.row:hover { background:var(--panel2); }
.head { padding-top:9px; padding-bottom:9px; border-bottom:1px solid var(--rule2); }
.head:hover { background:transparent; }
.pcts { display:flex; flex-direction:column; gap:5px; }
.pl { display:grid; grid-template-columns:26px 1fr 58px; gap:9px; align-items:center; }
.pl .track { height:5px; border-radius:3px; background:var(--rule2); overflow:hidden; }
.pl .track i { display:block; height:100%; border-radius:3px; }
.pv { font-family:'IBM Plex Mono',ui-monospace,monospace; font-size:11px; text-align:right; }
.hol { display:flex; align-items:center; gap:7px; justify-content:flex-end; flex-wrap:wrap; }

/* --- the reading register ------------------------------------------------
 *
 * A third face, and one rule decides which is which. Monospace is what the
 * ledger recorded: ids, states, numbers. The sans is the console's own
 * chrome. The serif is words a person wrote or will read - a customer's
 * message, a drafted reply, a document's text.
 *
 * A reader can tell them apart without a label, which is why there is no
 * label. System faces only: the CSP grants no font-src, so a web font would
 * be requested and blocked, and the page would silently fall back anyway.
 */
.prose {
  font-family: Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif;
  font-size: 15px;
  line-height: 1.62;
  /* Under 80 characters. Longer lines lose the reader between one line and
   * the next, and a responder reads dozens of these a day. */
  max-width: 68ch;
  color: var(--ink);
}
.prose + .discl { margin-top: 12px; }

/* One claim of a draft. The mark is the point: an unsupported claim is the
 * sentence an approver came to find. */
.claim { border-radius: 2px; padding: 0 1px; }
.claim.unsupported {
  background: color-mix(in oklab, var(--hot) 18%, transparent);
  box-shadow: inset 0 -2px 0 var(--hot);
}
.claim.unread { box-shadow: inset 0 -2px 0 var(--rule2); }
/* Lit from its source, and the reverse. Applied by the one script this
 * console ships, and absent when it does not run. */
.claim.lit, .src.lit { background: color-mix(in oklab, var(--accent) 22%, transparent); }

/* The citation marker. Small, superscript, and a link even without script. */
.cite {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 9.5px;
  vertical-align: super;
  margin-left: 2px;
  padding: 0 2px;
  border-radius: 2px;
  background: var(--panel2);
  color: var(--accent);
  text-decoration: none;
}
.cite:hover { color: var(--ink); background: var(--rule2); }

.src {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 7px 0; border-bottom: 1px solid var(--rule);
  scroll-margin-top: 12px;
}
.src:last-child { border-bottom: 0; }

/* --- the conversation ---------------------------------------------------- */
.turn {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  gap: 4px 20px;
  padding: 16px 0;
  border-bottom: 1px solid var(--rule);
}
.turn:last-child { border-bottom: 0; }
.turnmeta {
  display: flex; flex-direction: column; gap: 4px;
  align-items: flex-start;
}
.said { grid-column: 2; padding-bottom: 10px; }
.who {
  font-size: 10px; letter-spacing: .09em; text-transform: uppercase;
  color: var(--dim); font-weight: 500; margin-bottom: 5px;
}
/* An absence is a sentence, never a blank. Six of them exist and each one
 * sends a reader somewhere different. */
.absent {
  margin: 0; font-size: 12.5px; color: var(--mut); font-style: italic;
}

@media (max-width: 720px) {
  .turn { grid-template-columns: minmax(0, 1fr); }
  .said { grid-column: 1; }
}

/* The rail in two groups. The label is what separates them; a rule would
 * read as a divider between five peers rather than two kinds of work. */
.navgroup { display: flex; flex-direction: column; }
.navgroup + .navgroup { margin-top: 14px; }
.navgroup > .lbl { padding: 0 14px 5px; }

/* Spans the run detail's two columns. Prose in a 326px track is prose at
 * forty characters, and the reading measure is the point of the register. */
.full { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 16px; }
`;
