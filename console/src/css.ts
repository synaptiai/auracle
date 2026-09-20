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
// The tokens, the rail, the motion and the focus ring follow the reviewer
// design handoff (issue #100), whose values are final. The rest comes from the
// earlier canvas under `docs/design/console-canvas/`.
// The canvas holds five artboards and each carries its own `<style>` block, so
// joining them into one stylesheet meant resolving four collisions. A
// concatenation would have let the last artboard read win, silently:
//
//   - `.shell` is a 188px rail beside the main column on Main. On Approvals
//     the canvas drew a queue beside a detail pane. The rail is the shell every
//     surface shares, so the queue is a list page inside it, and each case is a
//     page of its own.
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
  /* The handoff's faces, then what each platform installs. The console fetches
   * no font, and Chromium ignores ui-monospace, so a stack that fell straight
   * to the generic monospace drew Courier. */
  --sans:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;
  /* The handoff's scale: space on a 4 and 8 grid, three radii, three durations.
   * The rail and the motion use it. The canvas rules below still carry literal
   * sizes, and each screen adopts the scale as it moves to the handoff design. */
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px; --s7:48px;
  --r-sm:4px; --r-md:8px; --r-lg:12px;
  --dur-fast:150ms; --dur-normal:200ms; --dur-slow:300ms;
  --ease-smooth:cubic-bezier(0.22, 1, 0.36, 1);
  --ease-spring:cubic-bezier(0.35, 1.55, 0.65, 1);
  /* The handoff's depth: a hairline ring and a layered shadow. The canvas cards
   * below still draw a 1px border until their screen moves to this design. */
  --ring:inset 0 0 0 1px rgba(255,255,255,.055);
  --ring-strong:inset 0 0 0 1px rgba(255,255,255,.10);
  --shadow-1:0 1px 1px rgba(0,0,0,.30), 0 2px 6px rgba(0,0,0,.22);
  --shadow-2:0 1px 1px rgba(0,0,0,.34), 0 4px 12px rgba(0,0,0,.28), 0 12px 32px rgba(0,0,0,.22);
  --surface:linear-gradient(180deg, #16181c 0%, #131518 100%);
  font-family:var(--sans); background:var(--bg); color:var(--ink);
  font-size:13px; line-height:1.45; min-height:100vh; box-sizing:border-box;
  -webkit-font-smoothing:antialiased;
}
.root[data-theme="light"] {
  --bg:#f7f7f5; --panel:#ffffff; --panel2:#f1f1ee; --ink:#17181a; --mut:#5f656c;
  --dim:#9198a0; --rule:#e4e4e0; --rule2:#d3d3ce;
  --accent:oklch(0.52 0.12 255); --warn:oklch(0.58 0.11 78); --hot:oklch(0.55 0.14 42);
  --crit:oklch(0.52 0.16 22); --ok:oklch(0.52 0.10 155);
  /* The design gives depth for the dark theme only. A white hairline vanishes
     on a white panel, so the light theme draws the same ring and shadow in
     black, at the strengths a light surface needs to read as raised. */
  --ring:inset 0 0 0 1px rgba(0,0,0,.06);
  --ring-strong:inset 0 0 0 1px rgba(0,0,0,.10);
  --shadow-1:0 1px 1px rgba(0,0,0,.05), 0 2px 6px rgba(0,0,0,.06);
  --shadow-2:0 1px 1px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.07), 0 12px 32px rgba(0,0,0,.08);
  --surface:linear-gradient(180deg, #ffffff 0%, #fbfbf9 100%);
}
.root *, .root *::before, .root *::after { box-sizing:border-box; }
.m { font-family:var(--mono); font-variant-numeric:tabular-nums; }
a { color:var(--accent); text-decoration:none; }
a:hover { color:var(--ink); text-decoration:underline; }
.lbl { font-size:10px; letter-spacing:.09em; text-transform:uppercase; color:var(--dim); font-weight:500; }
.chip { display:inline-flex; align-items:center; gap:5px; padding:2px 7px; border:1px solid var(--rule2);
  border-radius:3px; font-size:11px; font-family:var(--mono); color:var(--mut); white-space:nowrap; }
.dot { width:6px; height:6px; border-radius:50%; background:currentColor; flex:none; }
.mut { color:var(--mut); }

/* The shell: a fixed rail beside one scrolling column. */
.shell { display:grid; grid-template-columns:194px minmax(0,1fr); min-height:100vh; }
/* Sticky, and the artboard is why. The canvas draws a fixed-height board, so
   its rail sits beside the content by construction. A real runs page is 200
   rows long, and a rail that scrolls with them takes the navigation and the
   theme toggle off the screen at the first scroll. */
.rail { background:var(--panel); border-right:1px solid var(--rule); display:flex;
  flex-direction:column; position:sticky; top:0; height:100vh; overflow:auto; }
.brand { padding:16px 18px 14px; border-bottom:1px solid var(--rule); }
.brandname { font-size:15px; font-weight:600; letter-spacing:-.01em; }
.brandsub { margin-top:3px; }
.nav { display:flex; flex-direction:column; padding:10px 8px; gap:1px; }
.nav a { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 10px;
  border-radius:var(--r-md); color:var(--mut); font-size:13px; }
/* The label takes the room and gives it up first. Without both halves a long
   title wraps to two lines inside 194px and breaks the rail's rhythm. */
.navlabel { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.nav .badge { flex:none; white-space:nowrap; }
.nav a:hover { background:var(--panel2); color:var(--ink); text-decoration:none; }
.nav a.on { background:var(--panel2); color:var(--ink); box-shadow:inset 2px 0 0 var(--accent); }
.badge { font-family:var(--mono); font-size:11px; padding:1px 6px;
  border-radius:9px; background:var(--warn); color:#14161a; font-weight:600; }
.railfoot { margin-top:auto; padding:14px 18px; border-top:1px solid var(--rule);
  display:flex; flex-direction:column; gap:8px; align-items:flex-start; }
/* A name may carry marks that draw above or below its line. The block clips
 * its own ink, so nothing it holds draws over the rail. */
.reviewer { display:flex; align-items:center; gap:8px; min-width:0; max-width:100%; overflow:clip; }
.reviewer > div { min-width:0; }
.avatar { width:22px; height:22px; border-radius:50%; background:var(--panel2); border:1px solid var(--rule2);
  display:flex; align-items:center; justify-content:center; font-size:10px; color:var(--ink); flex:none; }
.rname { font-size:12px; overflow-wrap:anywhere; }
.rsub { font-size:10.5px; color:var(--dim); }
/* The rail is 194px and a ledger name is as long as its host. Left to the
   chip's own rules the name ran under the border and read as a different
   database: localhost:5433/auracle clipped to localhost:5433/aurac. */
/* A wrapped name keeps its dot on the first line, beside the word it marks. */
.railfoot .chip { max-width:100%; overflow-wrap:anywhere; white-space:normal; align-items:flex-start; }
.railfoot .chip .dot { margin-top:5px; }
.main { display:flex; flex-direction:column; min-width:0; }
.top { display:flex; align-items:center; justify-content:space-between; gap:16px;
  padding:12px 20px; border-bottom:1px solid var(--rule); background:var(--panel); }
.filters { display:flex; align-items:center; gap:8px; padding:11px 20px;
  border-bottom:1px solid var(--rule); flex-wrap:wrap; }
/* The options wrap rather than clip: twelve run states do not fit beside the
 * rail at 907px. The rule colour shows through a 1px gap as the dividers, and
 * each option grows to fill its row, so a wrapped row leaves no bare strip. */
.seg { display:flex; flex-wrap:wrap; gap:1px; background:var(--rule2); border:1px solid var(--rule2);
  border-radius:4px; overflow:hidden; }
.seg a { flex:1 0 auto; text-align:center; padding:4px 10px; font-size:11px; font-family:var(--mono);
  color:var(--mut); background:var(--bg); }
.seg a:hover { background:var(--panel2); color:var(--ink); text-decoration:none; }
.seg a.on { background:var(--accent); color:#0d0e10; }
/* 11px text needs 4.5:1, and near-black on the light accent reads 3.5:1. */
.root[data-theme="light"] .seg a.on { color:#ffffff; }
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
.kv dt { color:var(--dim); font-family:var(--mono); }
.kv dd { margin:0; font-family:var(--mono); color:var(--mut); }
.big { font-family:var(--mono); font-size:27px; font-weight:500;
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
  font-family:var(--mono); font-size:11px; }

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

/* The approval queue: every waiting run, each row a link to its case. */
.list { background:var(--panel); display:flex; flex-direction:column; }
.lhd { padding:14px 16px; border-bottom:1px solid var(--rule); }
.item { display:block; padding:12px 16px; border-bottom:1px solid var(--rule); color:inherit; }
.item:hover { background:var(--panel2); text-decoration:none; color:inherit; }
.btn { padding:8px 18px; border-radius:4px; font-size:12.5px; font-weight:600;
  border:1px solid transparent; font-family:var(--sans); cursor:pointer; }
.primary { background:var(--ok); color:#0d0e10; }
.warnbar { display:flex; gap:9px; align-items:flex-start; border:1px solid var(--rule2);
  border-left:2px solid var(--accent); border-radius:4px; padding:11px 13px; background:var(--panel); }
.outcome { border:1px solid var(--rule2); border-left:2px solid var(--accent); border-radius:4px;
  padding:11px 13px; background:var(--panel); font-size:12px; margin:0; }
/* Only an approval reads as a success. A refusal sent nothing, and it must not
 * wear the colour of one that did. */
.outcome.ok { border-left-color:var(--ok); }
.outcome.refused { border-left-color:var(--hot); color:var(--ink); }

/* Control bands: one card for each metric, and the legend the actions come from. */
.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:14px; }
.verdict { display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border-radius:3px;
  font-size:11px; font-family:var(--mono); font-weight:500; }
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
.pv { font-family:var(--mono); font-size:11px; text-align:right; }
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

/* The reply a reviewer edits, and the drafted sentences beside it (DEC-44).
 *
 * Two columns that wrap: the editor keeps a basis wide enough to write in,
 * and the preview drops below it on a narrow window rather than shrinking to
 * a column of three words. The same rule the case body itself follows. */
.editcols { display:flex; flex-wrap:wrap; gap:16px; align-items:flex-start; }
.editor { flex:1 1 420px; display:flex; flex-direction:column; gap:9px; }
.editor textarea {
  width:100%; box-sizing:border-box; padding:12px 13px; border-radius:4px;
  border:1px solid var(--rule2); background:var(--panel2); color:var(--ink);
  font-family:Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif;
  font-size:15px; line-height:1.62; resize:vertical;
}
.preview { flex:1 1 300px; max-width:420px; display:flex; flex-direction:column; gap:8px; }
/* The callout names the defect and offers the ways out of it. Ringed the way
 * the design handoff rings it: this is the one thing on the page that blocks
 * a send, and it must not read as one more paragraph. */
.callout { border:1px solid var(--rule2); border-left:2px solid var(--hot);
  border-radius:4px; padding:11px 13px; background:var(--panel); }
.callout p { margin:0 0 9px; font-size:12.5px; line-height:1.5; color:var(--ink); }
.callout form { display:inline; }
.callout .btn { margin:0 6px 6px 0; background:transparent; color:var(--ink); }
.callout input[type=text] {
  width:100%; box-sizing:border-box; margin:6px 0 8px; padding:8px 9px; border-radius:4px;
  border:1px solid var(--rule2); background:var(--panel2); color:var(--ink);
  font-family:var(--sans); font-size:12.5px;
}
.callout a.btn { display:inline-block; text-decoration:none; }

/* A queue row's top line: the ticket, and how long it has waited.
 *
 * The line wraps rather than starving its subject. The ticket keeps a basis
 * of its own and may break inside a long id; the age never shrinks, so on a
 * narrow row it drops below the ticket instead of squeezing it. */
.itop {
  display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
  gap: 2px 8px;
}
.isubj { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; font-size: 12.5px; }
.age {
  flex: none;
  font-family: var(--mono);
  font-size: 10.5px; color: var(--dim); white-space: nowrap;
}
.imeta { font-size: 10.5px; color: var(--dim); overflow-wrap: anywhere; }

/* A queue group's label, and the note that stands under the clean group. The
 * aside says where the escalated runs are. */
.qaside { margin: 0; padding: 10px 26px; border-bottom: 1px solid var(--rule); font-size: 12px; color: var(--mut); }
.qgroup { padding: 12px 16px 8px; border-bottom: 1px solid var(--rule); }
.qnote { margin: 6px 0 0; font-size: 11.5px; line-height: 1.5; color: var(--mut); }
/* The keys line above the queue, inset like the rows it annotates. */
.keys { font-size:11px; color:var(--dim); padding:10px 16px 12px; }

/* DEC-51: a row the batch can pick, and the panel a batch answers with.
 *
 * The box rides beside the row's anchor rather than inside it, and the row is
 * the flex container: the anchor keeps the full width it had, so a queue with
 * a checkbox column reads exactly like one without. */
.qrow { display:flex; align-items:flex-start; gap:9px; padding-left:14px; }
.qrow > .item { flex:1 1 auto; min-width:0; }
.qrow > input[type=checkbox] { margin-top:17px; accent-color:var(--ok); }
.qgroup .btn { margin-left:10px; }
/* The batch's answer: what was sent, what came back, and the undo. */
.panel { border:1px solid var(--rule2); border-radius:6px; padding:18px 20px; margin:18px 0; }
.panel.ok { border-left:2px solid var(--ok); }
.panel .big { display:block; margin-bottom:6px; }
.panel form { display:inline-block; margin-top:10px; }

/* One claim of a draft. The mark is the point: an unsupported claim is the
 * sentence an approver came to find. */
.claim { border-radius: 2px; padding: 0 1px;
  box-shadow: inset 0 -2px 0 color-mix(in oklab, var(--ok) 55%, transparent); }
.claim.unsupported {
  background: color-mix(in oklab, var(--hot) 18%, transparent);
  box-shadow: inset 0 -2px 0 var(--hot);
}
.claim.unread { box-shadow: inset 0 -2px 0 var(--rule2); }

/* A courtesy sentence: it opens or closes the reply and cites nothing
 * (DEC-43). Drawn quieter than the claims around it, so a reader can see at a
 * glance which sentences of the reply no document stands behind. Muted rather
 * than warned: it is not a defect, it is the part with no source. */
.courtesy { color: var(--mut); font-style: italic; }
/* Lit from its source, and the reverse. Applied by the one script this
 * console ships, and absent when it does not run. */
.claim.lit, .src.lit { background: color-mix(in oklab, var(--accent) 22%, transparent); }

/* The citation marker. Small, superscript, and a link even without script. */
.cite {
  font-family: var(--mono);
  font-size: 9.5px;
  display: inline-block;
  vertical-align: super;
  margin-left: 2px;
  padding: 0 2px;
  border-radius: 2px;
  background: var(--panel2);
  color: var(--accent);
  text-decoration: none;
}
.cite:hover { color: var(--ink); background: var(--rule2); }

/* A link alone in a table cell or a definition is the action of its row, not
 * a word in a sentence. So it is a box, and it presses. */
td a, dd a { display: inline-block; }

.src {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 7px 0; border-bottom: 1px solid var(--rule);
  scroll-margin-top: 12px;
}
.src:last-child { border-bottom: 0; }

/* --- the conversation ----------------------------------------------------
 *
 * A turn's number, time and outcome sit beside what was said while there is
 * room, and on a line above it when there is not. Flex bases rather than a
 * grid track, for the reason the case gives: a fixed track cannot give way. */
/* The handoff's thread width. A turn's rule across a wide page detaches the
 * chip from the text it describes. */
.turns { container-type:inline-size; max-width:1100px; }
.turn {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  padding: 18px 0;
  border-bottom: 1px solid var(--rule);
}
.turn:last-child { border-bottom: 0; }
.turnmeta {
  flex: 0 0 150px;
  display: flex; flex-direction: column; gap: 5px;
  align-items: flex-start;
}
/* The ledger's facts about a turn: its time, ticket, run and attempts. */
.turnfact { font-size:10.5px; color:var(--dim); overflow-wrap:anywhere; }
/* More than one run worked the turn, which a reader should notice. */
.turnfact.warn { color:var(--warn); }
.turnbody { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
/* 150 + 22 + 320. Below that the meta takes its own line, laid out as one.
 * A range rather than max-width, which leaves a fractional width between
 * 491px and 492px where the row wraps and the meta keeps its column. */
@container (width < 492px) {
  .turnmeta { flex-basis: 100%; flex-direction: row; flex-wrap: wrap; align-items: center; }
}
.who {
  font-size: 10px; letter-spacing: .09em; text-transform: uppercase;
  color: var(--dim); font-weight: 500; margin-bottom: 6px;
}
/* An absence is a sentence, never a blank. Each one sends a reader somewhere
 * different. */
.absent {
  margin: 0; font-size: 12.5px; color: var(--mut); font-style: italic;
}
/* In a turn the absence takes the place of the text, so it reads in the
 * text's own register. */
.said .absent {
  font-family: Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif;
  font-size: 15px; line-height: 1.62; max-width: 68ch;
  color: var(--mut); font-style: italic;
}
/* A reply that is drafted and waits for a person. */
.said .absent.waiting { color: var(--warn); }

/* The rail's groups. The label is what separates them; a rule would read as
 * a divider between peers rather than different kinds of work. */
.navgroup { display: flex; flex-direction: column; }
.navgroup + .navgroup { margin-top: 14px; }
.navgroup > .lbl { padding: 0 14px 5px; }

/* --- the design notes ----------------------------------------------------
 *
 * One column of cards, each with a rule on its left in the colour of what it
 * is about. The column stops at the handoff's 1000px, so a card's prose keeps
 * a readable measure on a wide page. */
.designnotes { max-width:1000px; gap:12px; }
.designnote { background:var(--panel); border:1px solid var(--rule); border-left-width:2px;
  border-radius:var(--r-lg); padding:15px 17px; }
.designnotetitle { font-size:13.5px; font-weight:600; }
.designnotesays { font-size:12.5px; color:var(--mut); margin-top:7px; max-width:88ch; }

/* --- the case -------------------------------------------------------------
 *
 * Two columns that wrap. The main column holds what the customer reads and
 * what it rests on; the context column holds why a person has it. Flex bases
 * rather than grid tracks: a fixed track cannot give way, and a case read
 * beside the rail at 907px has too little room for two. Below about 800px of
 * case width the context column drops under the main one, and takes the
 * whole width there. */
.casehd { padding:14px 24px; border-bottom:1px solid var(--rule); background:var(--panel);
  display:flex; flex-direction:column; gap:6px; }
.casehd .backrow { display:flex; gap:8px; align-items:baseline; align-self:flex-start; }
.casehd .back { font-size:12px; color:var(--mut); }
/* The key hint beside the back link, quieter than the link it annotates. */
.casehd .backkey { font-size:11px; color:var(--dim); }
.casetitle { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.casesubj { font-size:15px; font-weight:600; overflow-wrap:anywhere; }
.casemeta { font-size:11px; color:var(--dim); overflow-wrap:anywhere; }
.case { display:flex; flex-wrap:wrap; gap:24px; padding:20px 24px 28px; align-items:flex-start;
  container-type:inline-size; }
.casemain { flex:1 1 460px; min-width:0; display:flex; flex-direction:column; gap:16px; }
.caseside { flex:1 1 300px; max-width:360px; min-width:0; display:flex; flex-direction:column; gap:16px; }
/* 460 + 24 + 300: the width at which the columns wrap, as a range for the
 * reason the conversation gives. */
@container (width < 784px) {
  .caseside { max-width:none; }
}
/* The rule the journal recorded is the reason a person has this case. */
.why { border-left:2px solid var(--hot); }
.why p { margin:0 0 8px; font-size:12.5px; }
.why p:last-child { margin-bottom:0; }
/* The approval stays in reach at the foot of the window, however long the
 * reply is. The warning sits beside the button, so the bar stays short enough
 * to leave the case readable on a short screen, and wraps when it cannot. */
.actionbar { position:sticky; bottom:0; z-index:1; background:var(--panel);
  border-top:1px solid var(--rule2); padding:10px 24px; display:flex; flex-wrap:wrap;
  align-items:center; gap:8px 16px; }
.actionbar .warnbar { flex:1 1 420px; min-width:0; }
.actionbar form { flex:none; margin:0; }
.actionbar .discl { flex:1 1 100%; margin:0; }
.actionbar .readback { flex:1 1 100%; margin:0; font-size:11px; color:var(--mut); }
/* DEC-48: the case a reviewer finishes with no reply. Its own row under the
 * approval, so the primary control stays the one a reviewer reaches for and
 * the close is never one stray press away from it. */
.actionbar .closebar, .actionbar .snoozebar, .actionbar .rewritebar {
  flex:1 1 100%; display:flex; flex-wrap:wrap;
  align-items:center; gap:8px 12px; border-top:1px solid var(--rule2); padding-top:9px; }
.actionbar .closebar .discl, .actionbar .snoozebar .discl,
.actionbar .rewritebar .discl { flex:1 1 100%; margin:0; }
.actionbar .closebar form, .actionbar .snoozebar form, .actionbar .rewritebar form {
  flex:none; display:flex; gap:8px; align-items:center; margin:0; }
/* The period field is narrow: a number of minutes, not a paragraph. */
.actionbar .snoozebar input[name="minutes"] { width:6.5em; }
/* The rewritten reply is a textarea, so the bar stacks it over its button. */
.actionbar .rewritebar form { flex:1 1 100%; flex-wrap:wrap; }
.actionbar .rewritebar textarea { flex:1 1 100%; width:auto; min-height:96px; }
/* The gates one above the other, in a column too narrow for two cards. */
.gates.rows { grid-template-columns:minmax(0, 1fr); }
/* Why a gate has no value, beside its dash. */
.gateabsent { font-size:11px; color:var(--mut); }
/* The verdict in a word, beside the sentence it marks. The underline is
 * colour, and colour is not read by everyone. */
.vw { font-family:var(--mono); font-size:9.5px; letter-spacing:.04em; text-transform:uppercase;
  margin-left:4px; font-style:normal; white-space:nowrap; }
.vw.ok { color:var(--ok); }
.vw.refused { color:var(--hot); }
.vw.unread { color:var(--dim); }
.vw.courtesy { color:var(--mut); }

/* Spans the run detail's two columns. Prose in a 326px track is prose at
 * forty characters, and the reading measure is the point of the register. */
.full { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 16px; }

/* --- motion and focus -----------------------------------------------------
 *
 * One orchestrated entrance, not scattered effects. The content region rises
 * in once per page. Interactive elements press on a spring, rows and rail
 * items warm on hover, and a reader who asked for less motion gets none.
 *
 * The entrance fills backwards and never forwards. The delay then shows the
 * start frame, and once the entrance ends no animated value stays in effect.
 * A kept end frame computes as an identity matrix and a zero blur, not as
 * none. Either one gives every fixed descendant a new containing block, and
 * every child a stacking context, for the life of the page.
 *
 * A transform does not act on an inline box. So a button or a boxed link
 * presses, and a link inside a sentence underlines on hover instead. The
 * citation marker and a link alone in a table cell or a definition are boxes,
 * so they press.
 *
 * A segmented control clips its children to its rounded border. Its focus ring
 * therefore sits inside each button, where the clip cannot cut it. The chosen
 * button is filled with the accent, so its ring takes the text colour: an
 * accent ring on an accent fill is no ring.
 */
@keyframes riseIn {
  from { opacity:0; transform:translateY(8px); filter:blur(3px); }
  to { opacity:1; transform:none; filter:none; }
}
.main > * { animation:riseIn var(--dur-slow) var(--ease-smooth) backwards 60ms; }
.root a, .root button { transition:transform var(--dur-fast) var(--ease-spring),
  background-color var(--dur-fast) var(--ease-smooth), color var(--dur-fast) var(--ease-smooth); }
.root a:active, .root button:active { transform:scale(.97); }
.item, .row, tbody tr { transition:background-color var(--dur-fast) var(--ease-smooth); }
.root :focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:var(--r-md); }
.seg a:focus-visible { outline-offset:-2px; border-radius:0; }
.seg a.on:focus-visible { outline-color:currentColor; }
@media (prefers-reduced-motion: reduce) {
  .root *, .root *::before, .root *::after { animation:none !important; transition:none !important; }
}
`;
