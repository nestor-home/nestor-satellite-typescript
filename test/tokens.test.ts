import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalStorageTokenStore, MemoryTokenStore, type StorageLike } from "../src/index.js";
import { FileTokenStore } from "../src/node/tokens.js";

const CORE = "http://nestor.local:7860";

class MapStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

const refusing: StorageLike = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe.each([
  ["in memory", () => new MemoryTokenStore()],
  [
    "in localStorage",
    () => {
      const storage = new MapStorage();
      return new LocalStorageTokenStore("k", () => storage);
    },
  ],
  ["in a file", async () => new FileTokenStore(join(await mkdtemp(join(tmpdir(), "nestor-")), "dir", "t.json"))],
])("a token kept %s", (_where, make) => {
  it("comes back for the same core and device only", async () => {
    const store = await make();
    expect(await store.load(CORE, "salon")).toBeNull();
    await store.save(CORE, "salon", "nst1_secret");
    expect(await store.load(CORE, "salon")).toBe("nst1_secret");
    expect(await store.load("http://other:7860", "salon")).toBeNull();
    expect(await store.load(CORE, "cuisine")).toBeNull();
  });

  it("is gone once forgotten", async () => {
    const store = await make();
    await store.save(CORE, "salon", "nst1_secret");
    await store.forget();
    expect(await store.load(CORE, "salon")).toBeNull();
    await store.forget();
  });
});

describe("in a browser", () => {
  it("a storage that refuses access reads as no token and never throws", () => {
    const store = new LocalStorageTokenStore("k", () => refusing);
    store.save(CORE, "salon", "nst1_secret");
    expect(store.load(CORE, "salon")).toBeNull();
    store.forget();
  });

  it("no storage at all (a worker, Node) is no token", () => {
    const store = new LocalStorageTokenStore();
    store.save(CORE, "salon", "nst1_secret");
    expect(store.load(CORE, "salon")).toBeNull();
  });
});

describe("in a file", () => {
  it("is readable by its owner only, even when an older file was more open", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "nestor-")), "t.json");
    await writeFile(path, "{}", { mode: 0o644 });
    await new FileTokenStore(path).save(CORE, "salon", "nst1_secret");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ core: CORE, device_id: "salon", token: "nst1_secret" });
  });

  it("a corrupt file is no token", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "nestor-")), "t.json");
    await writeFile(path, "not json");
    expect(await new FileTokenStore(path).load(CORE, "salon")).toBeNull();
  });
});
