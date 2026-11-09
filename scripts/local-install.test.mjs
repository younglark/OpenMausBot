import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "./local-install.mjs";

describe("local-install arguments", () => {
  it("installs the packaged app and launches it by default", () => {
    const options = parseArgs([]);
    expect(options.run).toBe(false);
    expect(options.launch).toBe(true);
    expect(options.keepUpdate).toBe(false);
    expect(options.skipBuild).toBe(false);
    expect(options.dryRun).toBe(false);
    expect(options.dir).toBeNull();
  });

  it("reads the build and install switches", () => {
    const options = parseArgs(["--run", "--clean", "--skip-build", "--no-install", "--no-launch", "--keep-update", "--yes", "--dry-run", "--allow-unsupported-node"]);
    expect(options).toMatchObject({
      run: true, clean: true, skipBuild: true, noInstall: true, launch: false,
      keepUpdate: true, yes: true, dryRun: true, allowUnsupportedNode: true,
    });
  });

  it("resolves --dir against the working directory", () => {
    expect(parseArgs(["--dir", "build/here"]).dir).toBe(path.resolve("build/here"));
  });

  it("keeps an absolute --dir as given", () => {
    const absolute = path.resolve("somewhere", "OpenMausBot");
    expect(parseArgs(["--dir", absolute]).dir).toBe(absolute);
  });

  it("rejects an unknown option instead of ignoring it", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option --nope/);
  });

  it("rejects --dir without a path", () => {
    expect(() => parseArgs(["--dir"])).toThrow(/--dir needs a path/);
    expect(() => parseArgs(["--dir", "--yes"])).toThrow(/--dir needs a path/);
  });

  it("rejects a --dir that would break the unquoted NSIS /D= argument", () => {
    expect(() => parseArgs(["--dir", 'C:\\bad"path'])).toThrow(/quotes or newlines/);
    expect(() => parseArgs(["--dir", "C:\\bad\npath"])).toThrow(/quotes or newlines/);
  });
});
