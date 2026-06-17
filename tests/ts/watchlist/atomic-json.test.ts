import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { writeAtomicJson } from "../../../src/watchlist/atomic-json";

describe("writeAtomicJson", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("writes JSON file with given content", () => {
    const fp = path.join(tmpDir, "out.json");
    writeAtomicJson(fp, { a: 1, b: "x" });
    const read = JSON.parse(fs.readFileSync(fp, "utf-8"));
    expect(read).toEqual({ a: 1, b: "x" });
  });

  it("leaves no .tmp file behind on success", () => {
    const fp = path.join(tmpDir, "out.json");
    writeAtomicJson(fp, { a: 1 });
    expect(fs.existsSync(fp + ".tmp")).toBe(false);
  });

  it("creates parent directories if missing", () => {
    const fp = path.join(tmpDir, "nested", "deep", "out.json");
    writeAtomicJson(fp, { a: 1 });
    expect(JSON.parse(fs.readFileSync(fp, "utf-8"))).toEqual({ a: 1 });
  });
});
