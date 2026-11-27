import { randomUUID } from "node:crypto";
import { runQueueConformance } from "./test-support/conformance";
import { createMemoryQueue, MemoryQueueStore } from "./test-support/memory-queue";

runQueueConformance("memory", async (policy) => {
  const store = new MemoryQueueStore();
  return {
    open: async () => createMemoryQueue(store, policy),
    publishFrame: async (projectId, frame) => store.push(projectId, frame),
    projectIds: [randomUUID(), randomUUID(), randomUUID()],
    deadLetters: async () => store.deadLetters,
    close: async () => undefined,
  };
});
