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
    .shell { display:grid; grid-template-columns:188px 1fr; height:100%; }
    .rail { background:var(--panel); border-right:1px solid var(--rule); display:flex; flex-direction:column; }
    .brand { padding:16px 18px 14px; border-bottom:1px solid var(--rule); }
    .nav { display:flex; flex-direction:column; padding:10px 8px; gap:1px; }
    .nav a { display:flex; align-items:center; justify-content:space-between; padding:7px 10px;
      border-radius:4px; color:var(--mut); font-size:13px; }
    .nav a:hover { background:var(--panel2); color:var(--ink); text-decoration:none; }
    .nav a.on { background:var(--panel2); color:var(--ink); box-shadow:inset 2px 0 0 var(--accent); }
    .badge { font-family:'IBM Plex Mono',monospace; font-size:11px; padding:1px 6px; border-radius:9px;
      background:var(--warn); color:#14161a; font-weight:600; }
    .main { display:flex; flex-direction:column; min-width:0; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:16px;
      padding:12px 20px; border-bottom:1px solid var(--rule); background:var(--panel); }
    .filters { display:flex; align-items:center; gap:8px; padding:11px 20px; border-bottom:1px solid var(--rule);
      flex-wrap:wrap; }
    .seg { display:flex; border:1px solid var(--rule2); border-radius:4px; overflow:hidden; }
    .seg span { padding:4px 10px; font-size:11px; font-family:'IBM Plex Mono',monospace; color:var(--mut);
      border-right:1px solid var(--rule2); }
    .seg span:last-child { border-right:0; }
    .seg span.on { background:var(--accent); color:#0d0e10; }
    .search { flex:1; min-width:180px; border:1px solid var(--rule2); border-radius:4px; padding:4px 9px;
      color:var(--dim); font-family:'IBM Plex Mono',monospace; font-size:11px; background:transparent; }
    table { width:100%; border-collapse:collapse; }
    thead th { text-align:left; font-size:10px; letter-spacing:.09em; text-transform:uppercase;
      color:var(--dim); font-weight:500; padding:9px 12px; border-bottom:1px solid var(--rule2);
      position:sticky; top:0; background:var(--bg); }
    tbody td { padding:8px 12px; border-bottom:1px solid var(--rule); font-size:12px; vertical-align:middle; }
    tbody tr:hover { background:var(--panel); }
    .num { font-family:'IBM Plex Mono',monospace; font-variant-numeric:tabular-nums; }
    .gate { display:flex; align-items:center; gap:7px; }
    .bar { width:44px; height:4px; border-radius:2px; background:var(--rule2); overflow:hidden; flex:none; }
    .bar i { display:block; height:100%; }
    .st { display:inline-flex; align-items:center; gap:6px; font-family:'IBM Plex Mono',monospace; font-size:11px; }
    .foot { margin-top:auto; padding:10px 20px; border-top:1px solid var(--rule); display:flex;
      justify-content:space-between; align-items:center; color:var(--dim); font-size:11px; }
    .note { padding:9px 20px; background:var(--panel); border-bottom:1px solid var(--rule);
      color:var(--mut); font-size:11px; display:flex; gap:8px; align-items:center; }
  </style>
</helmet>
<div class="root" data-theme="{{theme}}">
<div class="shell">
  <div class="rail">
    <div class="brand">
      <div class="m" style="font-size:15px; font-weight:600; letter-spacing:-.01em">auracle</div>
      <div class="lbl" style="margin-top:3px">operator console</div>
    </div>
    <div class="nav">
      <a href="#" class="on">Runs<span class="num" style="color:var(--dim); font-size:11px">2 481</span></a>
      <a href="#">Approvals<span class="badge">7</span></a>
      <a href="#">Control bands</a>
      <a href="#">Partition latency</a>
      <a href="#">Escalations<span class="num" style="color:var(--dim); font-size:11px">3</span></a>
      <a href="#">Evidence base</a>
      <a href="#">Artifacts</a>
    </div>
    <div style="margin-top:auto; padding:14px 18px; border-top:1px solid var(--rule); display:flex; flex-direction:column; gap:7px">
      <div class="lbl">Bound to</div>
      <div class="chip" style="justify-content:flex-start"><span class="dot" style="color:var(--ok)"></span>ledger · localhost:5433</div>
      <div class="chip" style="justify-content:flex-start"><span class="dot" style="color:var(--ok)"></span>freescout · :8080</div>
      <div class="chip" style="justify-content:flex-start"><span class="dot" style="color:var(--accent)"></span>openrouter</div>
    </div>
  </div>

  <div class="main">
    <div class="top">
      <div style="display:flex; align-items:baseline; gap:12px">
        <div style="font-size:15px; font-weight:600">Runs</div>
        <div class="lbl">one row per run of the state machine</div>
      </div>
      <div style="display:flex; gap:8px; align-items:center">
        <span class="chip">prompt classify-p1</span>
        <span class="chip">model z-ai/glm-5.3-flash</span>
        <span class="chip m">2026-09-04 11:20 UTC</span>
      </div>
    </div>

    <div class="filters">
      <div class="seg">
        <span class="on">all</span><span>gated</span><span>awaiting_approval</span><span>escalated</span><span>resolved</span>
      </div>
      <span class="chip">risk: any</span>
      <span class="chip">partition: any</span>
      <span class="chip">intent: any</span>
      <div class="search">search ticket id, conversation id or intent</div>
    </div>

    <div class="note">
      <span class="dot" style="color:var(--accent)"></span>
      Agreement and coverage are two independent gates. This console never shows a combined confidence score.
    </div>

    <div style="overflow:auto; flex:1">
    <table>
      <thead>
        <tr>
          <th style="width:118px">run</th>
          <th style="width:104px">ticket</th>
          <th style="width:150px">state</th>
          <th>intent</th>
          <th style="width:66px">risk</th>
          <th style="width:44px">part</th>
          <th style="width:112px">agreement</th>
          <th style="width:112px">coverage</th>
          <th style="width:158px">decided by</th>
          <th style="width:58px; text-align:right">age</th>
        </tr>
      </thead>
      <tbody>
        <sc-for list="{{rows}}" as="r" hint-placeholder-count="10">
        <tr>
          <td class="num" style="color:var(--mut)">{{r.run}}</td>
          <td class="num">{{r.ticket}}</td>
          <td><span class="st" style="color: {{r.stateColor}}"><span class="dot"></span>{{r.state}}</span></td>
          <td style="color:var(--mut)">{{r.intent}}</td>
          <td><span class="chip" style="color: {{r.riskColor}}">{{r.risk}}</span></td>
          <td class="num" style="color:var(--dim)">{{r.part}}</td>
          <td>
            <div class="gate">
              <span class="bar"><i style="width: {{r.agrPct}}; background: {{r.agrColor}}"></i></span>
              <span class="num" style="color: {{r.agrColor}}">{{r.agr}}</span>
            </div>
          </td>
          <td>
            <div class="gate">
              <span class="bar"><i style="width: {{r.covPct}}; background: {{r.covColor}}"></i></span>
              <span class="num" style="color: {{r.covColor}}">{{r.cov}}</span>
            </div>
          </td>
          <td class="num" style="color:var(--mut)">{{r.reason}}</td>
          <td class="num" style="text-align:right; color:var(--dim)">{{r.age}}</td>
        </tr>
        </sc-for>
      </tbody>
    </table>
    </div>

    <div class="foot">
      <div>Showing 10 of 2 481 runs · every statement on this page is a SELECT</div>
      <div class="m">p50 service 1.9s · p99 14.2s</div>
    </div>
  </div>
</div>
</div>
</x-dc>
<script data-dc-script data-props='{"theme":{"editor":"enum","options":["dark","light"],"default":"dark","section":"Display"}}'>
class Component extends DCLogic {
  renderVals() {
    const C = {
      auto: 'var(--ok)', gated: 'var(--warn)', wait: 'var(--accent)',
      esc: 'var(--crit)', done: 'var(--mut)', dim: 'var(--dim)'
    };
    const risk = { high: 'var(--hot)', medium: 'var(--warn)', low: 'var(--mut)' };
    const g = (v, thr) => (v === null ? C.dim : v >= thr ? 'var(--ok)' : 'var(--crit)');
    const raw = [
      ['a41f2c9e','SYN-002841','awaiting_approval',C.wait,'refund-request','high','3',0.778,0.86,'customer_visible','2m'],
      ['7b03d158','SYN-002840','resolved',C.done,'invoice-copy-request','medium','1',0.889,0.94,'auto','4m'],
      ['c9e7a044','SYN-002839','gated',C.gated,'data-deletion-request','high','0',0.667,0.71,'high_risk','6m'],
      ['1d88b3f2','SYN-002838','resolved',C.done,'login-trouble','medium','2',1.000,0.97,'auto','9m'],
      ['58aa9017','SYN-002837','escalated',C.esc,'chargeback-notice','high','3',0.556,0.62,'groundedness_block','11m'],
      ['e230f7bb','SYN-002836','awaiting_approval',C.wait,'billing-dispute','high','1',0.778,0.81,'customer_visible','14m'],
      ['96c4d5a1','SYN-002835','gated',C.gated,'plan-change-question','medium','2',0.667,0.79,'groundedness_review','18m'],
      ['0f7e1a63','SYN-002834','resolved',C.done,'how-to-question','low','0',0.889,0.99,'auto','21m'],
      ['b5219cd0','SYN-002833','superseded',C.dim,'sync-error-report','medium','3',0.556,null,'agreement','24m'],
      ['3ac60e8f','SYN-002832','composed',C.wait,'api-usage-question','low','1',0.778,0.88,'auto','26m']
    ];
    return {
      rows: raw.map(([run, ticket, state, stateColor, intent, r, part, agr, cov, reason, age]) => ({
        run, ticket, state, stateColor, intent, part, reason, age,
        risk: r, riskColor: risk[r],
        agr: agr.toFixed(3), agrPct: Math.round(agr * 100) + '%', agrColor: g(agr, 0.6),
        cov: cov === null ? '  --' : cov.toFixed(2),
        covPct: cov === null ? '0%' : Math.round(cov * 100) + '%',
        covColor: cov === null ? C.dim : g(cov, 0.75)
      }))
    };
  }
}
</script>
</body>
</html>
