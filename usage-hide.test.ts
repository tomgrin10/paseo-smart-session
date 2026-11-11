import assert from "node:assert/strict";
import { test } from "node:test";

import { decide, hideStylesheet, sameNumbers, GRACE_ANIMATION, type CardFacts } from "./shared/usage-hide.ts";

const rows = (entries: Record<string, string>) => new Map(Object.entries(entries));
const facts = (over: Partial<CardFacts> = {}): CardFacts => ({
  enabled: true,
  hideable: new Map([["H2", "claude-two"]]),
  loginHash: "H2",
  theirs: rows({ Session: "30%", Weekly: "60%" }),
  ours: new Map([["claude-two", rows({ Session: "30%", Weekly: "60%" })]]),
  graceOver: false,
  shown: false,
  ...over,
});

test("hidden only beside our card for the same login showing the same numbers", () => {
  assert.equal(decide(facts()), "hide");
  // Ours read at another moment (the live bug: built-in 30%, ours 20%): both show.
  assert.equal(decide(facts({ ours: new Map([["claude-two", rows({ Session: "20%", Weekly: "60%" })]]) })), "show");
  // Another login.
  assert.equal(decide(facts({ loginHash: "H9" })), "show");
  // The built-in card names no login.
  assert.equal(decide(facts({ loginHash: null })), "show");
  // Our card for another account only.
  assert.equal(decide(facts({ ours: new Map([["claude-main", rows({ Session: "30%" })]]), graceOver: true })), "show");
});

test("waits unseen for our card during the grace, then shows the built-in", () => {
  // Cold: the built-in arrives first. It waits, unseen.
  assert.equal(decide(facts({ ours: new Map() })), "wait");
  // Ours never arrives: once the grace is over the built-in shows.
  assert.equal(decide(facts({ ours: new Map(), graceOver: true })), "show");
  // Ours arrives inside the grace with the same numbers: hidden, never seen.
  assert.equal(decide(facts({ graceOver: false })), "hide");
});

test("once shown, a card stays shown while mounted, so the list never loses a card it showed", () => {
  assert.equal(decide(facts({ shown: true })), "show");
});

test("a hidden card comes back the moment its numbers move apart from ours", () => {
  // A refetch brings the built-in a newer reading than our cached card: graceOver (already decided) and different numbers.
  assert.equal(decide(facts({ graceOver: true, theirs: rows({ Session: "31%", Weekly: "60%" }) })), "show");
});

test("nothing hides with the setting off or before the server has answered", () => {
  assert.equal(decide(facts({ enabled: false })), "show");
  assert.equal(decide(facts({ hideable: null })), "show");
  assert.equal(decide(facts({ hideable: new Map() })), "show");
});

test("numbers compare as rendered, on the windows both cards show, and at least one", () => {
  assert.equal(sameNumbers(rows({ Session: "30%", "Weekly · Fable": "5%" }), rows({ Session: " 30% " })), true);
  assert.equal(sameNumbers(rows({ Session: "70% left" }), rows({ Session: "70% left" })), true);
  assert.equal(sameNumbers(rows({ Session: "30%" }), rows({ Weekly: "30%" })), false);
  assert.equal(sameNumbers(rows({}), rows({})), false);
});

test("the stylesheet holds built-in cards back only inside Paseo's usage lists, and hides only decided ones", () => {
  const css = hideStylesheet(true);
  assert.match(css, /\[data-testid="context-window-details"\] \[data-testid\^="usage-report-claude:"\]\[data-smart-session-usage="hide"\]/);
  assert.match(css, /\[data-testid="usage-modal-body"\] \[data-testid\^="usage-report-claude:"\]:not\(\[data-smart-session-usage\]\),/);
  assert.match(css, /:not\(\[data-smart-session-usage\]\) \{ animation: smart-session-usage-grace 1500ms linear 1; \}/);
  assert.match(css, new RegExp(`@keyframes ${GRACE_ANIMATION} \\{ from, to \\{ display: none; \\} \\}`));
  // A box holding only the built-in card gives up its border and gap; a list holding more is never touched.
  assert.match(css, /\[data-testid="usage-modal-body"\] :has\(> \[data-testid\^="usage-report-claude:"\]:not\(\[data-smart-session-usage="show"\]\)\):not\(:has\(> \* \+ \*\)\)/);
  assert.match(css, /\{ display: contents !important; \}/);
  // Never our own cards, never anything outside the lists.
  assert.doesNotMatch(css, /smart-session:"/);
  assert.doesNotMatch(css, /^\[data-testid\^="usage-report-claude:"\]/m);
  // Nothing to stand in for: no grace, so nothing is held back.
  assert.doesNotMatch(hideStylesheet(false), /animation/);
});

test("the client's synchronous SHA-256 matches Node's, so a login on screen hashes like the server's", async () => {
  const { createHash } = await import("node:crypto");
  const { sha256Hex } = await import("./shared/sha256.ts");
  for (const text of ["", "abc", "seat-two@example.com", "x".repeat(55), "y".repeat(56), "z".repeat(64), "ünïcode@exämple.com", "😀@example.com", "a".repeat(1000)]) {
    assert.equal(sha256Hex(text), createHash("sha256").update(text).digest("hex"), JSON.stringify(text.slice(0, 20)));
  }
});
