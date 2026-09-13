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
    .card { background:var(--panel); border:1px solid var(--rule); border-radius:5px; }
    .card > header { padding:10px 14px; border-bottom:1px solid var(--rule); display:flex;
      align-items:center; justify-content:space-between; gap:10px; }
    .card > .body { padding:14px; }
    .prose { font-family:Charter,'Bitstream Charter','Sitka Text',Cambria,Georgia,serif;
      font-size:15px; line-height:1.62; max-width:68ch; color:var(--ink); }
    .kv { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; margin:0; font-size:12px; }
    .kv dt { color:var(--dim); font-family:'IBM Plex Mono',monospace; }
    .kv dd { margin:0; font-family:'IBM Plex Mono',monospace; color:var(--mut); }
  </style>
</helmet>
<div class="root" data-theme="{{theme}}">
<div class="wrap">

  <div class="hd">
    <div>
      <div style="font-size:16px; font-weight:600">Evidence base</div>
      <div style="color:var(--mut); font-size:12px; margin-top:4px">
        One document of the index, as it stands now. A citation is worth showing only if it can be checked.
      </div>
    </div>
    <div style="display:flex; gap:8px; align-items:center">
      <span class="chip">document</span>
      <span class="chip">billing-team</span>
      <span class="chip" style="color:var(--ok)"><span class="dot"></span>in review until 2027-03-31</span>
    </div>
  </div>

  <div>
    <div style="font-size:17px; font-weight:600">Refund eligibility windows</div>
    <div class="m" style="color:var(--mut); font-size:12px; margin-top:3px">SYN-DOC-01</div>
  </div>

  <div class="card">
    <header>
      <span class="lbl">What this document says today</span>
      <span class="chip">rewritten in place on reindex</span>
    </header>
    <div class="body">
      <div class="prose">
        A subscription charge is refundable in full inside fourteen days of the charge date.
        After that window the account keeps access until the end of the paid period.
        A refund on a disputed charge waits for the dispute to close.
      </div>
    </div>
  </div>

  <div class="card">
    <header>
      <span class="lbl">Why today is not the run's</span>
      <span class="chip" style="color:var(--warn)">DEC-23</span>
    </header>
    <div class="body" style="display:flex; flex-direction:column; gap:11px">
      <div class="discl">
        Documents are rewritten in place when the index is rebuilt, so this is the current text and
        not the text a run retrieved. Only the id is a historical fact. A run detail says whether the
        body moved since that run read it, and the run's own snapshot is what answers it.
      </div>
      <dl class="kv">
        <dt>review_by</dt><dd>2027-03-31</dd>
        <dt>owner</dt><dd>billing-team</dd>
        <dt>kind</dt><dd>document</dd>
      </dl>
      <div class="discl">
        Past its review date a document leaves the automatic path. A claim resting on one is a claim
        resting on text nobody has checked, and the header says so rather than leaving it to be read
        off a date.
      </div>
    </div>
  </div>

</div>
</div>
</x-dc>
<script data-dc-script data-props='{"theme":{"editor":"enum","options":["dark","light"],"default":"dark","section":"Display"}}'>
class Component extends DCLogic {
  renderVals() { return {}; }
}
</script>
</body>
</html>
