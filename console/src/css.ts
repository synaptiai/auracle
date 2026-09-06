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
export const CONSOLE_CSS = `
body { margin: 0; }
    .root {
      --bg:#0d0e10; --panel:#141619; --panel2:#1a1d21; --ink:#e6e7e8; --mut:#878d95;
      --dim:#5b626a; --rule:#25292e; --rule2:#31363c;
      --accent:oklch(0.66 0.11 255); --warn:oklch(0.72 0.11 78); --hot:oklch(0.66 0.13 42);
      --crit:oklch(0.62 0.15 22); --ok:oklch(0.68 0.09 155);
      font-family:'IBM Plex Sans',system-ui,sans-serif; background:var(--bg); color:var(--ink);
      font-size:13px; line-height:1.45; min-height:100%; box-sizing:border-box;
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
      border-radius:3px; font-size:11px; font-family:'IBM Plex Mono',monospace; color:var(--mut); }
    .dot { width:6px; height:6px; border-radius:50%; background:currentColor; flex:none; }
`;
