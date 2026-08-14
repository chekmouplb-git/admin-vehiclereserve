// Smoke test: loads admin.html in jsdom against a fake GAS backend and
// exercises load, render, escaping, retry-on-404, and the write path.
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "fs";

const html = fs.readFileSync("/root/che-vehicle-admin/admin.html", "utf8");

let pass = 0, fail = 0;
const ok  = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// ── Fake dataset, deliberately nasty ────────────────────────────
const today = new Date();
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const plus = n => { const d = new Date(today); d.setDate(d.getDate()+n); return iso(d); };

const bootstrap = () => ({
  ok: true,
  schedules: [
    { source:"Dean Sched", date: iso(today), dateDisplay:"today", startTime:"8:00 AM", endTime:"10:00 AM",
      destination:"Los Baños", purpose:"Meeting", passengers:"", email:"dean@uplb.edu.ph",
      remarks:"", status:"Scheduled", rowIndex: 2 },
    // Apostrophe + HTML in the data — v1 broke on both.
    { source:"Reservations", reservationCode:"RSV-001", date: iso(today), dateDisplay:"today",
      startTime:"1:00 PM", endTime:"4:00 PM", destination:"O'Brien Hall <script>alert(1)</script>",
      purpose:"Field work", remarks:"", mainRequestor:"Maria D'Souza", mainEmail:"m@x.com",
      status:"Pencil Booked", reason:"", rowIndex:3, allPassengers:[{name:"A",email:"a@x.com"},{name:"B",email:"b@x.com"}],
      passengerCount:2, vehicle:"Toyota Hi-Ace (ABC-123)", driver:"Juan Cruz" },
    { source:"Reservations", reservationCode:"RSV-002", date: plus(5), dateDisplay:"later",
      startTime:"7:00 AM", endTime:"6:00 PM", destination:"Manila", purpose:"Conference",
      remarks:"", mainRequestor:"Pedro", mainEmail:"p@x.com", status:"Approved", reason:"",
      rowIndex:5, allPassengers:[{name:"C",email:"c@x.com"}], passengerCount:1,
      vehicle:"Nissan Urvan (XYZ-999)", driver:"Ana Reyes" }
  ],
  pending: [
    { source:"Reservations", reservationCode:"RSV-001", date: iso(today), startTime:"1:00 PM", endTime:"4:00 PM",
      destination:"O'Brien Hall <script>alert(1)</script>", purpose:"Field work",
      mainRequestor:"Maria D'Souza", mainEmail:"m@x.com", status:"Pencil Booked",
      allPassengers:[{name:"A",email:"a@x.com"},{name:"B",email:"b@x.com"}], passengerCount:2,
      vehicle:"Toyota Hi-Ace (ABC-123)", driver:"Juan Cruz" }
  ],
  destinations: ["Los Baños", "Manila", "O'Brien Hall"],
  vehicles: [{ name:"Toyota Hi-Ace", plate:"ABC-123" }, { name:"Nissan Urvan", plate:"XYZ-999" }],
  drivers: ["Juan Cruz", "Ana Reyes"],
  generatedAt: new Date().toISOString()
});

// ── Fake fetch that fails the way real GAS fails ────────────────
let getCalls = 0, postCalls = 0, lastPostBody = null;
let force404Times = 0;

function makeFetch() {
  return async function (url, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    if (method === "POST") {
      postCalls++;
      lastPostBody = JSON.parse(opts.body);
      const data = bootstrap();
      return respond(200, JSON.stringify({ success:true, message:"ok", emailSent:true, data }));
    }
    getCalls++;
    if (force404Times > 0) { force404Times--; return respond(404, "<html>Not Found</html>"); }
    return respond(200, JSON.stringify(bootstrap()));
  };
}
function respond(status, text) {
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function run(label, { fail404 = 0 } = {}) {
  console.log(`\n── ${label} ──`);
  getCalls = 0; postCalls = 0; force404Times = fail404;

  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", e => errors.push(e.message));
  vc.on("error", (...a) => errors.push(a.join(" ")));

  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://example.org/admin.html",
    virtualConsole: vc,
    beforeParse(w) {
      w.fetch = makeFetch();
      w.AbortController = class { constructor(){ this.signal = {}; } abort(){} };
      w.confirm = () => true;
    }
  });

  const w = dom.window, doc = w.document;
  // Backoff is 500 + 1000 + 2000 ms plus up to 400ms jitter each, so a
  // fully-failing run needs ~5s before it gives up and paints the banner.
  await wait(fail404 ? 6000 : 600);

  ok("no uncaught page errors", errors.length === 0, errors.join(" | "));
  return { dom, w, doc };
}

// ═══ TEST 1: happy path ═══
{
  const { w, doc } = await run("Happy path");

  ok("exactly ONE network request on load (v1 made 4)", getCalls === 1, `got ${getCalls}`);
  ok("connection banner hidden", !doc.getElementById("connBanner").classList.contains("is-open"));

  const cells = doc.querySelectorAll("#calGrid .cal-cell");
  ok("calendar rendered a full month grid", cells.length >= 28, `got ${cells.length}`);
  ok("calendar has no skeleton left", doc.querySelectorAll("#calGrid .skel").length === 0);
  ok("today's cell carries items", doc.querySelectorAll("#calGrid .cal-cell.has-items").length >= 1);

  ok("badge-calendar = 3", doc.getElementById("badge-calendar").textContent === "3",
     doc.getElementById("badge-calendar").textContent);
  ok("badge-today = 2", doc.getElementById("badge-today").textContent === "2",
     doc.getElementById("badge-today").textContent);
  ok("badge-upcoming = 1", doc.getElementById("badge-upcoming").textContent === "1",
     doc.getElementById("badge-upcoming").textContent);
  ok("badge-pending = 1", doc.getElementById("badge-pending").textContent === "1",
     doc.getElementById("badge-pending").textContent);

  // XSS / escaping
  const pendHtml = doc.getElementById("pendingContainer").innerHTML;
  ok("pending table renders a row", pendHtml.includes("RSV-001"));
  ok("script tag from sheet data is ESCAPED, not live",
     !pendHtml.includes("<script>alert(1)"), "raw <script> leaked into DOM");
  ok("no injected script element exists", doc.querySelectorAll("#pendingContainer script").length === 0);
  ok("apostrophe in requestor survives", pendHtml.includes("D&#39;Souza") || pendHtml.includes("D'Souza"));

  // Dropdowns populated
  ok("approve vehicle select populated", doc.getElementById("approveVehicle").options.length === 2);
  ok("approve driver select populated", doc.getElementById("approveDriver").options.length === 2);
  ok("destination datalist populated", doc.getElementById("destList").children.length === 3);

  // Today tab content
  ok("today list rendered cards", doc.querySelectorAll("#todayList .item-card").length === 2,
     String(doc.querySelectorAll("#todayList .item-card").length));
  ok("upcoming list rendered cards", doc.querySelectorAll("#upcomingList .item-card").length === 1);

  // Delegated action controls exist with data attributes (no inline onclick)
  // Exclude <script> text — the source contains the word in a comment.
  const markupOnly = Array.from(doc.body.children)
    .filter(n => n.tagName !== "SCRIPT").map(n => n.innerHTML).join("");
  ok("no inline onclick handlers remain", !markupOnly.includes("onclick="));
  ok("pending row has delegated action select", !!doc.querySelector('#pendingContainer select[data-act="res"]'));
  ok("dean card has delegated status select", !!doc.querySelector('#todayList select[data-act="dean"]'));

  // ── Interaction: open a calendar day ──
  const cell = doc.querySelector("#calGrid .cal-cell.has-items");
  cell.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await wait(50);
  ok("clicking a day opens the day modal", doc.getElementById("dayModal").classList.contains("is-open"));
  doc.getElementById("closeDayModal").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await wait(30);
  ok("day modal closes", !doc.getElementById("dayModal").classList.contains("is-open"));

  // ── Interaction: approve flow ──
  const sel = doc.querySelector('#pendingContainer select[data-act="res"]');
  sel.value = "approve";
  sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(60);
  ok("approve modal opened", doc.getElementById("approveConfirmModal").classList.contains("is-open"));
  ok("approve pre-selects the REQUESTED vehicle, not the first one",
     doc.getElementById("approveVehicle").value.split("||")[0] === "Toyota Hi-Ace",
     doc.getElementById("approveVehicle").value);
  ok("approve pre-selects the current driver",
     doc.getElementById("approveDriver").value === "Juan Cruz", doc.getElementById("approveDriver").value);
  ok("reassign-reason box hidden when nothing changed",
     doc.getElementById("approveReasonWrap").style.display === "none");

  // Change the driver -> reason box must appear
  const dSel = doc.getElementById("approveDriver");
  dSel.value = "Ana Reyes";
  dSel.dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(30);
  ok("changing driver reveals the reason box",
     doc.getElementById("approveReasonWrap").style.display === "block");

  // Submit without a reason -> must be blocked
  const beforePosts = postCalls;
  doc.getElementById("submitApproveConfirm").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await wait(80);
  ok("blocked submit when reassignment reason is empty", postCalls === beforePosts, `posts ${postCalls}`);

  // Provide reason and submit
  doc.getElementById("approveReason").value = "Requested van under maintenance";
  const getsBefore = getCalls;
  doc.getElementById("submitApproveConfirm").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await wait(300);
  ok("approve POSTed once", postCalls === beforePosts + 1, `posts ${postCalls}`);
  ok("POST asked for inline refreshed data", lastPostBody && lastPostBody.returnData === true);
  ok("POST flagged as a reassignment", lastPostBody && lastPostBody.isReassignment === true);
  ok("POST carried the reason", lastPostBody && lastPostBody.supporting === "Requested van under maintenance");
  ok("NO extra GET reload after the write (v1 fired 4)", getCalls === getsBefore, `extra gets: ${getCalls - getsBefore}`);
  ok("approve modal closed after submit", !doc.getElementById("approveConfirmModal").classList.contains("is-open"));

  // ── Interaction: reassign modal prefill ──
  const btn = doc.querySelector('[data-btn="reassign"]');
  if (btn) {
    btn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await wait(60);
    ok("reassign modal opened", doc.getElementById("reassignModal").classList.contains("is-open"));
    ok("reassign prefills existing vehicle",
       doc.getElementById("reassignVehicle").value.split("||")[0] === "Nissan Urvan",
       doc.getElementById("reassignVehicle").value);
    ok("reassign prefills start time in 24h",
       doc.getElementById("reassignStart").value === "07:00", doc.getElementById("reassignStart").value);
    ok("reassign prefills end time in 24h",
       doc.getElementById("reassignEnd").value === "18:00", doc.getElementById("reassignEnd").value);
    doc.getElementById("cancelReassign").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  } else {
    ok("reassign button present on approved card", false, "not found");
  }
}

// ═══ TEST 2: the 404 that used to break the page ═══
{
  const { doc } = await run("Transient 404 x2 then success", { fail404: 2 });
  ok("retried past the 404s", getCalls === 3, `requests made: ${getCalls}`);
  ok("page recovered — banner NOT shown", !doc.getElementById("connBanner").classList.contains("is-open"));
  ok("data actually rendered after recovery", doc.getElementById("badge-calendar").textContent === "3",
     doc.getElementById("badge-calendar").textContent);
  ok("calendar populated after recovery", doc.querySelectorAll("#calGrid .cal-cell.has-items").length >= 1);
}

// ═══ TEST 3: permanent failure surfaces cleanly ═══
{
  const { doc } = await run("Permanent 404 (all attempts fail)", { fail404: 99 });
  ok("gave up after MAX_RETRIES+1 attempts", getCalls === 4, `requests made: ${getCalls}`);
  ok("banner shown to the user", doc.getElementById("connBanner").classList.contains("is-open"));
  ok("banner has a Retry button", !!doc.getElementById("connRetry"));
  ok("page did not crash", doc.querySelectorAll("#calGrid").length === 1);
}

console.log(`\n${"═".repeat(46)}\n  ${pass} passed, ${fail} failed\n${"═".repeat(46)}`);
process.exit(fail ? 1 : 0);
