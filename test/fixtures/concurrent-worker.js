// Child process for test/concurrency.test.js: one "agent" hammering a shared store.
import { MemoryStore } from "../../src/store/memory-store.js";
import { HashEmbedder } from "../../src/embeddings.js";

const [file, agent, countArg] = process.argv.slice(2);
const count = Number(countArg);
const store = MemoryStore.open(file, { embedder: new HashEmbedder() });
let errors = 0;
let seenOthers = 0;

for (let i = 0; i < count; i++) {
  try {
    await store.write({ topic: `${agent} note ${i}`, content: `Shared fact ${i} from ${agent}`, agent, tags: [agent] });
    if (i % 10 === 0) {
      const { results } = await store.search({ query: `shared fact ${i}`, limit: 10 });
      if (results.some((r) => r.agent !== agent)) seenOthers++;
      // Contended counter: CAS retry loop.
      for (;;) {
        const cur = store.getState("counter");
        try {
          store.setState("counter", (cur?.value ?? 0) + 1, { expectedVersion: cur?.version ?? 0 });
          break;
        } catch (e) {
          if (e.code !== "CONFLICT") throw e;
        }
      }
    }
  } catch (e) {
    errors++;
    process.stderr.write(`${agent}: ${e.message}\n`);
  }
}
store.close();
process.stdout.write(JSON.stringify({ agent, errors, seenOthers }));
