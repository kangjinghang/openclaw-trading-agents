import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findLatestSnapshot } from "../../src/diff-cli";

describe("findLatestSnapshot", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wl-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("返回 raw 目录里日期最大的快照", () => {
    const raw = path.join(tmp, "raw");
    fs.mkdirSync(raw);
    fs.writeFileSync(path.join(raw, "2026-06-16.json"), "{}");
    fs.writeFileSync(path.join(raw, "2026-06-18.json"), "{}");
    fs.writeFileSync(path.join(raw, "2026-06-17.json"), "{}");
    expect(findLatestSnapshot(tmp)).toBe("2026-06-18");
  });

  it("raw 目录不存在返回 null", () => {
    expect(findLatestSnapshot(tmp)).toBeNull();
  });

  it("raw 目录空返回 null", () => {
    fs.mkdirSync(path.join(tmp, "raw"));
    expect(findLatestSnapshot(tmp)).toBeNull();
  });
});
