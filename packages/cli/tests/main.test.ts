import { describe, it, expect, mock, spyOn, beforeEach, afterEach, afterAll } from "bun:test";
import { commandRegistry } from "../src/commands/registry";

const TEST_COMMAND = "__test_success";
const TEST_EXIT_COMMAND = "__test_exit";

process.env.MANDU_NO_BANNER = "1";

describe("CLI main lifecycle", () => {
  const exitSpy = spyOn(process, "exit");

  afterAll(() => {
    delete process.env.MANDU_NO_BANNER;
    exitSpy.mockRestore();
  });

  beforeEach(() => {
    commandRegistry.delete(TEST_COMMAND);
    commandRegistry.delete(TEST_EXIT_COMMAND);
    exitSpy.mockReset();
    exitSpy.mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    commandRegistry.delete(TEST_COMMAND);
    commandRegistry.delete(TEST_EXIT_COMMAND);
  });

  it("does not force process.exit(0) after a successful command", async () => {
    commandRegistry.set(TEST_COMMAND, {
      id: TEST_COMMAND,
      description: "test command",
      run: mock(async () => true),
    });

    const { main } = await import("../src/main");
    await expect(main([TEST_COMMAND]))
      .resolves
      .toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits after a successful one-shot command when requested", async () => {
    commandRegistry.set(TEST_EXIT_COMMAND, {
      id: TEST_EXIT_COMMAND,
      description: "test exit command",
      exitOnSuccess: true,
      run: mock(async () => true),
    });

    const { main } = await import("../src/main");
    await expect(main([TEST_EXIT_COMMAND]))
      .rejects
      .toThrow("process.exit:0");

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("parses --key=value style flags", async () => {
    const { parseArgs } = await import("../src/main");
    expect(parseArgs(["auth", "init", "--strategy=jwt"])).toEqual({
      command: "auth",
      options: {
        _positional: "init",
        strategy: "jwt",
      },
    });
  });
});
