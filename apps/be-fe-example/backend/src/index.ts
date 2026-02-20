import Fastify from "fastify";
import cors from "@fastify/cors";
import { contactRoutes } from "./routes/contact.js";
import { chatRoutes } from "./routes/chat.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await contactRoutes(app);
await chatRoutes(app);

app.listen({ port: 3011, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Server running on ${address}`);
});
