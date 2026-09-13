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
    .wrap { padding:20px 24px 28px; display:flex; flex-direction:column; gap:16px; }
    .hd { display:flex; align-items:flex-start; justify-content:space-between; gap:20px;
      padding-bottom:14px; border-bottom:1px solid var(--rule); }
    .kv { display:grid; grid-template-columns:auto auto; gap:3px 14px; font-size:11px; }
    .kv dt { color:var(--dim); font-family:'IBM Plex Mono',monospace; }
    .kv dd { margin:0; font-family:'IBM Plex Mono',monospace; color:var(--mut); }
    .cols { display:grid; grid-template-columns:326px 1fr; gap:16px; align-items:start; }
    .card { background:var(--panel); border:1px solid var(--rule); border-radius:5px; }
    .card > header { padding:10px 14px; border-bottom:1px solid var(--rule); display:flex;
      align-items:center; justify-content:space-between; gap:10px; }
    .card > .body { padding:14px; }
    .tl { display:flex; flex-direction:column; }
    .step { display:grid; grid-template-columns:14px 1fr; gap:11px; padding:0 0 2px; }
    .spine { display:flex; flex-direction:column; align-items:center; }
    .spine .k { width:9px; height:9px; border-radius:50%; border:2px solid var(--bg); margin-top:4px; flex:none; }
    .spine .l { width:1px; flex:1; background:var(--rule2); min-height:20px; }
    .stepbody { padding-bottom:14px; }
    .steptop { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
    .gates { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
    .gate { border:1px solid var(--rule2); border-radius:4px; padding:13px; display:flex;
      flex-direction:column; gap:10px; }
    .big { font-family:'IBM Plex Mono',monospace; font-size:27px; font-weight:500; letter-spacing:-.02em;
      font-variant-numeric:tabular-nums; line-height:1; }
    .track { height:6px; border-radius:3px; background:var(--rule2); position:relative; }
    .track i { position:absolute; inset:0 auto 0 0; border-radius:3px; }
    .track b { position:absolute; top:-4px; bottom:-4px; width:2px; background:var(--ink); }
    .ev { display:grid; grid-template-columns:22px 1fr 92px 116px; gap:10px; align-items:center;
      padding:8px 0; border-bottom:1px solid var(--rule); font-size:12px; }
    .ev:last-child { border-bottom:0; }
    .draft { border:1px solid var(--rule2); border-radius:4px; padding:14px; line-height:1.6;
      background:var(--panel2); }
    .discl { border-left:2px solid var(--warn); padding:9px 12px; background:var(--panel2);
      font-size:11.5px; color:var(--mut); }
  </style>
</helmet>
<div class="root" data-theme="{{theme}}">
<div class="wrap">

  <div class="hd">
    <div>
      <div style="display:flex; align-items:center; gap:10px">
        <span class="m" style="font-size:17px; font-weight:600">a41f2c9e</span>
        <span class="chip" style="color:var(--accent)"><span class="dot"></span>awaiting_approval</span>
      </div>
      <div style="color:var(--mut); margin-top:5px">Refund request — duplicate charge on one subscription month</div>
    </div>
    <dl class="kv">
      <dt>ticket</dt><dd>SYN-002841</dd>
      <dt>conversation</dt><dd>CONV-SYN-002841 · turn 2</dd>
      <dt>partition</dt><dd>3 of 8</dd>
      <dt>epoch</dt><dd>41</dd>
      <dt>cost</dt><dd>1 284 micros</dd>
      <dt>deadline</dt><dd>11:36:04Z (in 9m)</dd>
    </dl>
  </div>

  <div class="cols">

    <div class="card">
      <header>
        <span class="lbl">Step journal</span>
        <span class="chip">6 entries · written before each act</span>
      </header>
      <div class="body tl">
        <sc-for list="{{steps}}" as="s" hint-placeholder-count="6">
        <div class="step">
          <div class="spine">
            <span class="k" style="background: {{s.color}}"></span>
            <span class="l"></span>
          </div>
          <div class="stepbody">
            <div class="steptop">
              <span class="m" style="font-size:12.5px; color: {{s.color}}">{{s.name}}</span>
              <span class="m" style="font-size:11px; color:var(--dim)">{{s.ms}}</span>
            </div>
            <div style="color:var(--mut); font-size:11.5px; margin-top:2px">{{s.detail}}</div>
          </div>
        </div>
        </sc-for>
      </div>
    </div>

    <div style="display:flex; flex-direction:column; gap:16px">

      <div class="card">
        <header>
          <span class="lbl">The two gates</span>
          <span class="chip">independent · never combined</span>
        </header>
        <div class="body">
          <div class="gates">
            <div class="gate">
              <div class="lbl">Sample agreement</div>
              <div style="display:flex; align-items:baseline; gap:9px">
                <span class="big" style="color:var(--ok)">0.778</span>
                <span class="m" style="font-size:11px; color:var(--dim)">7 of 9 samples</span>
              </div>
              <div class="track"><i style="width:77.8%; background:var(--ok)"></i><b style="left:60%"></b></div>
              <div class="m" style="font-size:11px; color:var(--mut)">threshold 0.600 · seed &middot; PASS</div>
              <div style="font-size:11px; color:var(--dim)">9 samples at temperature 0.7. At temperature zero this number is always 1.000.</div>
            </div>
            <div class="gate">
              <div class="lbl">Groundedness coverage</div>
              <div style="display:flex; align-items:baseline; gap:9px">
                <span class="big" style="color:var(--warn)">0.86</span>
                <span class="m" style="font-size:11px; color:var(--dim)">6 of 7 claims</span>
              </div>
              <div class="track"><i style="width:86%; background:var(--warn)"></i><b style="left:75%"></b><b style="left:92%"></b></div>
              <div class="m" style="font-size:11px; color:var(--mut)">block 0.75 · review 0.92 · fitted v1 &middot; REVIEW</div>
              <div style="font-size:11px; color:var(--dim)">One claim has no supporting document. It is listed below.</div>
            </div>
          </div>
          <div style="margin-top:13px; padding-top:12px; border-top:1px solid var(--rule); display:flex; gap:9px; align-items:flex-start">
            <span class="dot" style="color:var(--accent); margin-top:6px"></span>
            <div style="font-size:11.5px; color:var(--mut)">
              Neither gate decided this run. It is a customer reply, so it needs a person whatever these numbers say.
              The policy engine returned <span class="m" style="color:var(--ink)">customer_visible</span> before it read either threshold.
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <header>
          <span class="lbl">Retrieved evidence</span>
          <span class="chip">the order the ledger recorded</span>
        </header>
        <div class="body" style="padding-top:4px">
          <div class="ev" style="border-bottom:1px solid var(--rule2)">
            <span class="lbl">#</span><span class="lbl">document</span>
            <span class="lbl" style="text-align:right">kind</span>
            <span class="lbl" style="text-align:right">owner</span>
          </div>
          <sc-for list="{{docs}}" as="d" hint-placeholder-count="4">
          <div class="ev">
            <span class="m" style="color:var(--dim)">{{d.n}}</span>
            <span><span class="m" style="color:var(--accent)">{{d.id}}</span> <span style="color:var(--mut)">{{d.title}}</span></span>
            <span class="m" style="text-align:right; color:var(--mut)">{{d.kind}}</span>
            <span class="m" style="text-align:right; color:var(--mut)">{{d.owner}}</span>
          </div>
          </sc-for>
        </div>
      </div>

      <div class="card">
        <header>
          <span class="lbl">Composed draft</span>
          <span class="chip">not sent · parked in freescout as draft #4471</span>
        </header>
        <div class="body" style="display:flex; flex-direction:column; gap:12px">
          <div class="draft">
            We can see two charges against your subscription for the same month. The duplicate is not
            correct, and we are refunding it to the card that was charged. Refunds reach most banks
            within five working days. Your subscription itself is unchanged and the next renewal date
            stays as it was.
          </div>
          <div class="discl">
            <strong style="color:var(--warn)">Disclosure (required, DEC-14)</strong><br>
            This reply was drafted by an automated assistant and approved by a person before it was sent.
          </div>
          <div style="display:flex; gap:24px; flex-wrap:wrap">
            <dl class="kv">
              <dt>generated_by</dt><dd>auracle/composer</dd>
              <dt>model_id</dt><dd>z-ai/glm-5.3-flash</dd>
            </dl>
            <dl class="kv">
              <dt>prompt_ver</dt><dd>compose-p3</dd>
              <dt>generated_at</dt><dd>2026-09-04T11:18:22Z</dd>
            </dl>
            <dl class="kv">
              <dt>unsupported claim</dt><dd style="color:var(--warn)">&ldquo;within five working days&rdquo;</dd>
              <dt>idem_key</dt><dd>reply:CONV-SYN-002841:2</dd>
            </dl>
          </div>
        </div>
      </div>

    </div>
  </div>
</div>
</div>
</x-dc>
<script data-dc-script data-props='{"theme":{"editor":"enum","options":["dark","light"],"default":"dark","section":"Display"}}'>
class Component extends DCLogic {
  renderVals() {
    const ok = 'var(--ok)', wait = 'var(--accent)', warn = 'var(--warn)';
    return {
      steps: [
        { name:'received', color:ok, ms:'+0ms', detail:'Turn 2 joined CONV-SYN-002841 by In-Reply-To.' },
        { name:'classified', color:ok, ms:'+2 140ms', detail:'refund-request · high risk · 9 samples, 7 agree.' },
        { name:'retrieved', color:ok, ms:'+2 810ms', detail:'4 documents fused from 12 candidates.' },
        { name:'composed', color:ok, ms:'+6 020ms', detail:'Draft written. Not abstained.' },
        { name:'gated', color:warn, ms:'+7 460ms', detail:'Coverage 0.86 landed in the review band.' },
        { name:'awaiting_approval', color:wait, ms:'+7 512ms', detail:'Parked as a draft. No outbox row exists yet.' }
      ],
      docs: [
        { n:'1', id:'DOC-SYN-002', title:'Refund windows for each plan', kind:'document', owner:'billing-team' },
        { n:'2', id:'RES-SYN-101', title:'Duplicate charge, resolved case', kind:'resolution', owner:'billing-team' },
        { n:'3', id:'DOC-SYN-014', title:'How a refund reaches the original card', kind:'document', owner:'billing-team' },
        { n:'4', id:'DOC-SYN-031', title:'Renewal dates after a partial refund', kind:'document', owner:'billing-team' }
      ]
    };
  }
}
</script>
</body>
</html>
