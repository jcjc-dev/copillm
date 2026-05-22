import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { choose, confirm } from "../src/auth/interactivePrompt.js";

interface FakeStdin extends EventEmitter {
  isTTY: boolean;
  setEncoding(encoding: string): FakeStdin;
  setRawMode(mode: boolean): FakeStdin;
  resume(): FakeStdin;
  pause(): FakeStdin;
}

function makeFakeStdin(isTTY: boolean): FakeStdin {
  const emitter = new EventEmitter() as FakeStdin;
  emitter.isTTY = isTTY;
  emitter.setEncoding = () => emitter;
  emitter.setRawMode = () => emitter;
  emitter.resume = () => emitter;
  emitter.pause = () => emitter;
  return emitter;
}

let originalStdin: NodeJS.ReadStream;
let originalWrite: typeof process.stdout.write;
let writtenChunks: string[];

beforeEach(() => {
  originalStdin = process.stdin;
  writtenChunks = [];
  originalWrite = process.stdout.write.bind(process.stdout);
  // Swallow CLI prompt output during tests; the contents are not asserted on.
  // Using a direct assignment (not vi.spyOn) avoids the overloaded-signature
  // type friction between vitest's MockInstance and stdout.write.
  process.stdout.write = ((chunk: unknown): boolean => {
    writtenChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
  process.stdout.write = originalWrite;
});

describe("interactivePrompt.confirm", () => {
  it("returns true for 'y'", async () => {
    const fakeStdin = makeFakeStdin(true);
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    const pending = confirm("OK?");
    // Defer the keypress to the next tick so the listener is attached first.
    setImmediate(() => fakeStdin.emit("data", "y"));
    await expect(pending).resolves.toBe(true);
  });

  it("returns false for 'n'", async () => {
    const fakeStdin = makeFakeStdin(true);
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    const pending = confirm("OK?");
    setImmediate(() => fakeStdin.emit("data", "n"));
    await expect(pending).resolves.toBe(false);
  });

  it("returns false for any non-y keypress (defaults to no)", async () => {
    const fakeStdin = makeFakeStdin(true);
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    const pending = confirm("OK?");
    setImmediate(() => fakeStdin.emit("data", "x"));
    await expect(pending).resolves.toBe(false);
  });

  it("throws on Ctrl+C", async () => {
    const fakeStdin = makeFakeStdin(true);
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    const pending = confirm("OK?");
    setImmediate(() => fakeStdin.emit("data", "\u0003"));
    await expect(pending).rejects.toThrow(/aborted/i);
  });

  it("refuses to prompt when stdin is not a TTY", async () => {
    const fakeStdin = makeFakeStdin(false);
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    await expect(confirm("OK?")).rejects.toThrow(/not a TTY/i);
  });
});

describe("interactivePrompt.choose", () => {
  it("returns the value for a matching key", async () => {
    const fakeStdin = makeFakeStdin(true);
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    const pending = choose<"a" | "b">(
      "pick one",
      [
        { key: "a", label: "alpha", value: "a" },
        { key: "b", label: "beta", value: "b" }
      ]
    );
    setImmediate(() => fakeStdin.emit("data", "b"));
    await expect(pending).resolves.toBe("b");
  });

  it("is case-insensitive on the key", async () => {
    const fakeStdin = makeFakeStdin(true);
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    const pending = choose<"x">(
      "pick",
      [{ key: "x", label: "x-thing", value: "x" }]
    );
    setImmediate(() => fakeStdin.emit("data", "X"));
    await expect(pending).resolves.toBe("x");
  });

  it("rejects when duplicate keys are supplied", async () => {
    const fakeStdin = makeFakeStdin(true);
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    await expect(
      choose("dup", [
        { key: "a", label: "first", value: 1 },
        { key: "A", label: "second", value: 2 }
      ])
    ).rejects.toThrow(/unique/i);
  });

  it("throws on Ctrl+C", async () => {
    const fakeStdin = makeFakeStdin(true);
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    const pending = choose("pick", [{ key: "a", label: "alpha", value: 1 }]);
    setImmediate(() => fakeStdin.emit("data", "\u0003"));
    await expect(pending).rejects.toThrow(/aborted/i);
  });
});
