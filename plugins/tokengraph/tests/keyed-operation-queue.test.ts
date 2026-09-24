import { describe, expect, it } from "vitest";

import { KeyedOperationQueue } from "../src/core/keyedOperationQueue.js";

describe("keyed operation queue", () => {
  it("releases a key after successful settlement", async () => {
    const queue = new KeyedOperationQueue();

    await expect(queue.enqueue("workspace-a", async () => "complete")).resolves.toBe("complete");

    expect(queue.pendingKeyCount).toBe(0);
  });

  it("releases a key after rejected settlement", async () => {
    const queue = new KeyedOperationQueue();

    await expect(queue.enqueue("workspace-a", async () => {
      throw new Error("expected failure");
    })).rejects.toThrow("expected failure");

    expect(queue.pendingKeyCount).toBe(0);
  });

  it("does not retain settled entries for many distinct keys", async () => {
    const queue = new KeyedOperationQueue();

    await Promise.all(Array.from({ length: 100 }, (_, index) =>
      queue.enqueue(`workspace-${index}`, async () => index)
    ));

    expect(queue.pendingKeyCount).toBe(0);
  });

  it("preserves same-key serialization", async () => {
    const queue = new KeyedOperationQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue("workspace-a", async () => {
      order.push("first-start");
      await firstBlocked;
      order.push("first-end");
    });
    const second = queue.enqueue("workspace-a", async () => {
      order.push("second-start");
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });
});
