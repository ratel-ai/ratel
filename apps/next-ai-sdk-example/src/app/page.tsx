import Link from "next/link";

export default function Home() {
  return (
    <div>
      <h1>Welcome</h1>
      <p>
        This app demonstrates an AI SDK agent embedded in a Next.js frontend
        with App Router.
      </p>
      <p>
        Use the chat widget in the bottom-right corner to talk to the agent, or
        visit the <Link href="/contact">contact page</Link> to send us a message.
      </p>
    </div>
  );
}
