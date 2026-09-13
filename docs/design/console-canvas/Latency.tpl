<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
/*CSS*/
    .wrap { padding:20px 24px 24px; display:flex; flex-direction:column; gap:15px; }
    .hd { display:flex; align-items:flex-start; justify-content:space-between; gap:20px;
      padding-bottom:13px; border-bottom:1px solid var(--rule); }
    .card { background:var(--panel); border:1px solid var(--rule); border-radius:5px; }
    .card > header { padding:11px 15px; border-bottom:1px solid var(--rule); display:flex;
      align-items:center; justify-content:space-between; gap:10px; }
    .row { display:grid; grid-template-columns:56px 1fr 1fr 108px; gap:18px; align-items:center;
      padding:11px 15px; border-bottom:1px solid var(--rule); }
    .row:last-child { border-bottom:0; }
    .row:hover { background:var(--panel2); }
    .head { padding-top:9px; padding-bottom:9px; border-bottom:1px solid var(--rule2); }
    .pcts { display:flex; flex-direction:column; gap:5px; }
    .pl { display:grid; grid-template-columns:26px 1fr 58px; gap:9px; align-items:center; }
    .track { height:5px; border-radius:3px; background:var(--rule2); overflow:hidden; }
    .track i { display:block; height:100%; border-radius:3px; }
    .hol { display:flex; align-items:center; gap:7px; justify-content:flex-end; }
    .note { display:flex; gap:9px; align-items:flex-start; padding:12px 15px; background:var(--panel);
      border:1px solid var(--rule); border-left:2px solid var(--accent); border-radius:5px; }
  </style>
</helmet>
<div class="root" data-theme="{{theme}}">
<div class="wrap">

  <div class="hd">
    <div>
      <div style="font-size:16px; font-weight:600">Partition latency</div>
      <div style="color:var(--mut); font-size:12px; margin-top:4px">
        Queue wait and service time for each partition, as percentiles. An average is where a tail hides.
      </div>
    </div>
    <div style="display:flex; gap:8px; align-items:center">
      <span class="chip">window 24h</span>
      <span class="chip">8 partitions</span>
      <span class="chip">2 481 runs</span>
    </div>
  </div>

  <div class="card">
    <div class="row head">
      <span class="lbl">part</span>
      <span class="lbl">queue wait — time from arrival to pickup</span>
      <span class="lbl">service time — pickup to terminal state</span>
      <span class="lbl" style="text-align:right">head of line</span>
    </div>
    <sc-for list="{{parts}}" as="p" hint-placeholder-count="8">
    <div class="row">
      <div>
        <div class="m" style="font-size:13px">{{p.id}}</div>
        <div class="m" style="font-size:10.5px; color:var(--dim)">{{p.runs}} runs</div>
      </div>
      <div class="pcts">
        <div class="pl"><span class="lbl">p50</span><span class="track"><i style="width: {{p.q50w}}; background:var(--mut)"></i></span><span class="m" style="font-size:11px; text-align:right; color:var(--mut)">{{p.q50}}</span></div>
        <div class="pl"><span class="lbl">p90</span><span class="track"><i style="width: {{p.q90w}}; background: {{p.color}}"></i></span><span class="m" style="font-size:11px; text-align:right; color: {{p.color}}">{{p.q90}}</span></div>
        <div class="pl"><span class="lbl">p99</span><span class="track"><i style="width: {{p.q99w}}; background: {{p.color}}"></i></span><span class="m" style="font-size:11px; text-align:right; color: {{p.color}}">{{p.q99}}</span></div>
      </div>
      <div class="pcts">
        <div class="pl"><span class="lbl">p50</span><span class="track"><i style="width: {{p.s50w}}; background:var(--mut)"></i></span><span class="m" style="font-size:11px; text-align:right; color:var(--mut)">{{p.s50}}</span></div>
        <div class="pl"><span class="lbl">p90</span><span class="track"><i style="width: {{p.s90w}}; background:var(--accent)"></i></span><span class="m" style="font-size:11px; text-align:right; color:var(--mut)">{{p.s90}}</span></div>
        <div class="pl"><span class="lbl">p99</span><span class="track"><i style="width: {{p.s99w}}; background:var(--accent)"></i></span><span class="m" style="font-size:11px; text-align:right; color:var(--mut)">{{p.s99}}</span></div>
      </div>
      <div class="hol">
        <span class="chip" style="color: {{p.color}}"><span class="dot"></span>{{p.hol}}</span>
      </div>
    </div>
    </sc-for>
  </div>

  <div class="note">
    <span class="dot" style="color:var(--accent); margin-top:6px"></span>
    <div style="font-size:11.5px; color:var(--mut)">
      Partition 3 shows the delay this measurement exists to expose. Its p99 queue wait is
      <span class="m" style="color:var(--hot)">41.6s</span> while its p50 service time is
      <span class="m" style="color:var(--ink)">1.9s</span> — so the tickets behind one slow run are
      waiting on that run, not on work of their own.
      <span style="color:var(--dim)">Two runs on one conversation still never overlap.</span>
    </div>
  </div>

</div>
</div>
</x-dc>
<script data-dc-script data-props='{"theme":{"editor":"enum","options":["dark","light"],"default":"dark","section":"Display"}}'>
class Component extends DCLogic {
  renderVals() {
    const raw = [
      ['0', 312, [0.4, 1.9, 4.2], [1.7, 5.1, 12.0], 'clear', 'var(--ok)'],
      ['1', 341, [0.5, 2.4, 6.1], [1.8, 5.6, 13.4], 'clear', 'var(--ok)'],
      ['2', 298, [0.4, 2.1, 5.0], [1.9, 5.2, 12.8], 'clear', 'var(--ok)'],
      ['3', 366, [1.2, 14.8, 41.6], [1.9, 6.0, 15.2], 'blocked', 'var(--hot)'],
      ['4', 287, [0.5, 2.8, 7.4], [1.7, 4.9, 11.6], 'clear', 'var(--ok)'],
      ['5', 304, [0.6, 3.9, 9.8], [2.0, 5.8, 14.1], 'watch', 'var(--warn)'],
      ['6', 279, [0.4, 2.0, 4.7], [1.8, 5.0, 12.2], 'clear', 'var(--ok)'],
      ['7', 294, [0.5, 2.6, 6.6], [1.9, 5.4, 13.0], 'clear', 'var(--ok)']
    ];
    const QMAX = 42, SMAX = 16;
    const s = (v) => v.toFixed(1) + 's';
    const w = (v, max) => Math.max(2, Math.round((v / max) * 100)) + '%';
    return {
      parts: raw.map(([id, runs, q, sv, hol, color]) => ({
        id, runs, hol, color,
        q50: s(q[0]), q90: s(q[1]), q99: s(q[2]),
        q50w: w(q[0], QMAX), q90w: w(q[1], QMAX), q99w: w(q[2], QMAX),
        s50: s(sv[0]), s90: s(sv[1]), s99: s(sv[2]),
        s50w: w(sv[0], SMAX), s90w: w(sv[1], SMAX), s99w: w(sv[2], SMAX)
      }))
    };
  }
}
</script>
</body>
</html>
