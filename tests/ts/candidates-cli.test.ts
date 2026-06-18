import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findLatestDiff } from "../../src/candidates-cli";

describe("findLatestDiff", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wl-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("返回 diff 目录里日期最大的文件", () => {
    const diff = path.join(tmp, "diff");
    fs.mkdirSync(diff);
    fs.writeFileSync(path.join(diff, "2026-06-16.json"), "{}");
    fs.writeFileSync(path.join(diff, "2026-06-17.json"), "{}");
    expect(findLatestDiff(tmp)).toBe("2026-06-17");
  });

  it("diff 目录不存在返回 null", () => {
    expect(findLatestDiff(tmp)).toBeNull();
  });
});
