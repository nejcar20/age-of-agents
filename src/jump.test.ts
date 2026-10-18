import { describe, expect, it } from "vitest";
import { jumpMessage } from "./jump";

describe("jumpMessage", () => {
  it("names the island that was jumped to", () => {
    expect(jumpMessage({ ok: true, island: "api" })).toBe("jumped to api");
  });

  it("says so when nothing is waiting instead of staying silent", () => {
    expect(jumpMessage({ ok: true, island: null })).toBe("nothing waiting");
  });

  it("surfaces the error rather than swallowing it", () => {
    // The case that made the app look broken: herdr is not running, the
    // connect fails, and the key press did nothing visible at all.
    expect(jumpMessage({ ok: false, error: "No such file or directory (os error 2)" })).toBe(
      "jump failed: No such file or directory (os error 2)",
    );
  });
});
