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
    .prose { font-family:Charter,'Bitstream Charter','Sitka Text',Cambria,Georgia,serif;
      font-size:15px; line-height:1.62; max-width:68ch; color:var(--ink); }
    .turn { display:grid; grid-template-columns:132px minmax(0,1fr); gap:4px 20px;
      padding:16px 0; border-bottom:1px solid var(--rule); }
    .turnmeta { display:flex; flex-direction:column; gap:4px; align-items:flex-start; }
    .said { grid-column:2; padding-bottom:10px; }
    .who { font-size:10px; letter-spacing:.09em; text-transform:uppercase; color:var(--dim);
      font-weight:500; margin-bottom:5px; }
    .absent { margin:0; font-size:12.5px; color:var(--mut); font-style:italic; }
  </style>
</helmet>
<div class="root" data-theme="{{theme}}">
<div class="wrap">

  <div class="hd">
    <div>
      <div style="font-size:16px; font-weight:600">Conversation</div>
      <div style="color:var(--mut); font-size:12px; margin-top:4px">
        One customer problem, and every turn of it. A conversation may span more than one ticket.
      </div>
    </div>
    <div style="display:flex; gap:8px; align-items:center">
      <span class="chip" style="color:var(--accent)">open</span>
      <span class="chip">3 turns</span>
      <span class="chip">participant named</span>
    </div>
  </div>

  <div>
    <div class="m" style="font-size:17px; font-weight:600">SYN-4471</div>
    <div style="color:var(--mut); font-size:12px; margin-top:3px">conversation 17faa30d-d6d1-4f35-9deb-86f65df36a41</div>
  </div>

  <sc-for list="{{turns}}" as="t" hint-placeholder-count="3">
  <div class="turn">
    <div class="turnmeta">
      <span class="lbl">turn {{t.n}}</span>
      <span class="m" style="font-size:10.5px; color:var(--dim)">{{t.ticket}}</span>
      <span class="m" style="font-size:10.5px; color:var(--accent)">{{t.state}}</span>
    </div>
    <div class="said">
      <div class="who">the customer wrote</div>
      <div class="prose">{{t.said}}</div>
    </div>
    <div class="said">
      <div class="who">the system replied</div>
      <div class="prose">{{t.reply}}</div>
    </div>
  </div>
  </sc-for>

  <div class="turn">
    <div class="turnmeta">
      <span class="lbl">turn 3</span>
      <span class="m" style="font-size:10.5px; color:var(--dim)">SYN-4482</span>
      <span class="m" style="font-size:10.5px; color:var(--dim)">no run</span>
    </div>
    <div class="said">
      <div class="who">the customer wrote</div>
      <div class="prose">And one more thing, has the second charge been reversed as well?</div>
    </div>
    <div class="said">
      <div class="who">the system replied</div>
      <p class="absent">no run joins this turn, so nothing here can say what happened</p>
    </div>
  </div>

  <div class="discl">
    Six absences, and each one sends a responder somewhere different: an internal write that sent
    nothing, a draft still waiting, a run that stopped, a run still going, a message nobody kept,
    and a customer who wrote nothing. None of them draws a blank.
  </div>

</div>
</div>
</x-dc>
<script data-dc-script data-props='{"theme":{"editor":"enum","options":["dark","light"],"default":"dark","section":"Display"}}'>
class Component extends DCLogic {
  renderVals() {
    return {
      turns: [
        {
          n: '1', ticket: 'SYN-4471', state: 'resolved',
          said: 'There are two charges against my subscription for the same month. I only expected one. Can you check?',
          reply: 'We can see two charges for the same month. The duplicate is not correct, and we are refunding it to the card that was charged. Your subscription is unchanged.'
        },
        {
          n: '2', ticket: 'SYN-4471', state: 'awaiting_approval',
          said: 'Thank you. How long does a refund take to appear?',
          reply: 'Your bank decides how quickly the refund appears. We do not have a date for it.'
        }
      ]
    };
  }
}
</script>
</body>
</html>
