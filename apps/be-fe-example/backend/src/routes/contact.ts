import type { FastifyInstance } from "fastify";

interface ContactBody {
  name: string;
  email: string;
  message: string;
}

export async function contactRoutes(app: FastifyInstance) {
  app.post<{ Body: ContactBody }>("/api/contact", async (request, reply) => {
    const { name, email, message } = request.body ?? {};

    if (!name || !email || !message) {
      return reply.status(400).send({ error: "All fields are required" });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.status(400).send({ error: "Invalid email format" });
    }

    console.log("[SENDING EMAIL]", { name, email, message });

    return reply
      .status(200)
      .send({ success: true, message: `Thanks ${name}, we received your message.` });
  });
}
