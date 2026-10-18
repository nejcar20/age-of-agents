// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnsiText } from "./AnsiText";

afterEach(cleanup);

describe("AnsiText", () => {
  it("renders plain text with no escape codes as-is", () => {
    const { container } = render(<AnsiText text="hello world" />);
    expect(container.textContent).toBe("hello world");
  });

  it("never leaves raw escape bytes visible, even for a non-colour control sequence", () => {
    // A plain quoted JSX attribute does NOT process JS backslash escapes
    // (a JSX quirk, distinct from a normal string literal) — an expression
    // container (`{"..."}`) is required for `\x1b` to mean the actual ESC
    // byte here rather than the five literal characters `\`, `x`, `1`, `b`.
    const { container } = render(<AnsiText text={"\x1b[2Kclearing\x1b[?25lhidden"} />);
    expect(container.textContent).toBe("clearinghidden");
    expect(container.textContent).not.toContain("\x1b");
  });

  it("applies the parsed colour as an inline style on its own span", () => {
    const { container } = render(<AnsiText text={"\x1b[32mgreen\x1b[0m"} />);
    const span = container.querySelector("span");
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe("green");
    expect(span?.style.color).not.toBe("");
  });
});
