import { describe, expect, test } from "bun:test";
import {
  nextBulk,
  nextClick,
  nextFailedWrite,
  nextNav,
  nextVerifiedWrite,
  pageDelta,
  refsAfterClick,
  refsAfterNav,
  refsAfterWrite,
  shouldPeek,
} from "./action-result";
import {
  clearLastAction,
  coachNoteForObserve,
  rememberAction,
} from "./last-action";

describe("nextVerifiedWrite", () => {
  test("clean write skips observe tools", () => {
    const n = nextVerifiedWrite({});
    expect(n.do).toBe("continue");
    expect(n.skipScreenshot).toBe(true);
    expect(n.skipFullSnapshot).toBe(true);
  });

  test("submit observes without screenshot", () => {
    const n = nextVerifiedWrite({ submitted: true });
    expect(n.do).toBe("observe");
    expect(n.skipScreenshot).toBe(true);
    expect(n.skipFullSnapshot).toBe(false);
  });

  test("invalid field asks to fix", () => {
    const n = nextVerifiedWrite({ invalidHint: true });
    expect(n.do).toBe("fix");
    expect(n.skipScreenshot).toBe(true);
  });
});

describe("nextFailedWrite", () => {
  test("points at snapshot + type", () => {
    const n = nextFailedWrite("nope");
    expect(n.do).toBe("fix");
    expect(n.suggest).toContain("browser_snapshot");
  });
});

describe("nextBulk", () => {
  test("all ok continues", () => {
    const n = nextBulk({ failed: 0, total: 3 });
    expect(n.do).toBe("continue");
    expect(n.skipScreenshot).toBe(true);
  });

  test("any failure is fix", () => {
    const n = nextBulk({ failed: 1, total: 3 });
    expect(n.do).toBe("fix");
  });
});

describe("refsAfterWrite", () => {
  test("same doc write keeps refs", () => {
    expect(refsAfterWrite({}).valid).toBe(true);
  });

  test("navigation invalidates refs", () => {
    expect(refsAfterWrite({ navigated: true }).valid).toBe(false);
  });
});

describe("pageDelta", () => {
  test("flags url change", () => {
    const d = pageDelta(
      { url: "https://a.test/", title: "A" },
      { url: "https://b.test/", title: "A" }
    );
    expect(d.urlChanged).toBe(true);
    expect(d.titleChanged).toBe(false);
  });
});

describe("nextClick / refsAfterClick", () => {
  test("same-doc click is soft unknown refs", () => {
    expect(refsAfterClick({}).valid).toBe("unknown");
    expect(nextClick({ changed: true }).skipScreenshot).toBe(true);
  });

  test("nav click forces snapshot", () => {
    expect(refsAfterClick({ navigated: true }).valid).toBe(false);
    expect(nextClick({ navigated: true }).do).toBe("observe");
  });
});

describe("nextNav", () => {
  test("successful nav observes", () => {
    expect(nextNav({ navigated: true }).do).toBe("observe");
    expect(refsAfterNav().valid).toBe(false);
  });

  test("failed nav is fix", () => {
    expect(nextNav({ navigated: false }).do).toBe("fix");
  });
});

describe("shouldPeek", () => {
  test("verified type without issues skips peek", () => {
    expect(
      shouldPeek({
        action: "type",
        ok: true,
        verified: true,
        changed: true,
      })
    ).toBe(false);
  });

  test("failed write peeks", () => {
    expect(shouldPeek({ action: "type", ok: false, warning: true })).toBe(true);
  });

  test("fill_form always peeks", () => {
    expect(shouldPeek({ action: "fill_form", ok: true, verified: true })).toBe(
      true
    );
  });
});

describe("coachNoteForObserve", () => {
  test("advises skip after verified type", () => {
    clearLastAction(42);
    rememberAction(42, {
      ok: true,
      verified: true,
      trusted: true,
      action: "type",
      page: { url: "https://x.test/", title: "x" },
      refs: { valid: true, reason: "ok" },
      next: {
        do: "continue",
        skipScreenshot: true,
        skipFullSnapshot: true,
        reason: "Value verified in the DOM.",
      },
      target: { ref: "e3" },
    });
    const shot = coachNoteForObserve(42, "screenshot");
    expect(shot).toContain("skipScreenshot");
    expect(shot).toContain("e3");
    const snap = coachNoteForObserve(42, "snapshot");
    expect(snap).toContain("refs.valid=true");
    clearLastAction(42);
  });
});
