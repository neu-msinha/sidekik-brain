import { describe, expect, it } from "vitest";
import { BACK_ON_RECORD_PATTERN, OFF_RECORD_PATTERN } from "../../src/capture/offrecord.js";
import { harness, noul } from "./harness.js";

describe("off-record (D7)", () => {
  it("prefilter matches the DESIGN phrases", () => {
    for (const s of ["Das ist jetzt off the record", "Das sag ich nur inoffiziell", "bitte nicht aufnehmen", "can you stop recording"]) {
      expect(OFF_RECORD_PATTERN.test(s)).toBe(true);
    }
    expect(OFF_RECORD_PATTERN.test("Das geht auf 0400.")).toBe(false);
    expect(BACK_ON_RECORD_PATTERN.test("ok, back on the record")).toBe(true);
  });

  it("turns without a match never reach Jev", async () => {
    const h = harness();
    await h.turn(1000, "Das ist die Rechnung von Präzisionswerk Ulm.");
    expect(h.jevCalls("D7")).toBe(0);
  });

  it("at ≥ 0.5 calls the gateway and pauses asking immediately", async () => {
    const h = harness({ off_record_request: noul(0.55), back_on_record: noul(0.02) });
    await h.turn(1000, "Das jetzt bitte inoffiziell.");
    expect(h.gateway.calls).toEqual([{ sessionId: "sess-1", on: true, t_ms: 1000 }]);
    expect(h.state().offRecord).toBe(true);
  });

  it("below 0.5 does nothing", async () => {
    const h = harness({ off_record_request: noul(0.3), back_on_record: noul(0.02) });
    await h.turn(1000, "Wir haben das früher inoffiziell gemacht.");
    expect(h.gateway.calls).toHaveLength(0);
    expect(h.state().offRecord).toBe(false);
  });

  it("reverts the local pause if the gateway call fails", async () => {
    const h = harness({ off_record_request: noul(0.9), back_on_record: noul(0.02) });
    h.gateway.setOffRecord = async () => {
      throw new Error("gateway down");
    };
    await expect(h.turn(1000, "off the record please")).rejects.toThrow(/gateway down/);
    expect(h.state().offRecord).toBe(false);
  });
});
