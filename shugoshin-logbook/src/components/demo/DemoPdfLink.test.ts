import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_SAMPLE_PDF } from "./DemoPdfLink";

describe("DEMO_SAMPLE_PDF", () => {
  it.each(Object.entries(DEMO_SAMPLE_PDF))("%s のリンク先が public/ に実在する PDF である", (_name, href) => {
    const file = resolve(__dirname, "../../../public", href.replace(/^\//, ""));
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).subarray(0, 5).toString()).toBe("%PDF-");
  });
});
