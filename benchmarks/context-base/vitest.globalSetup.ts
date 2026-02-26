import { GenericContainer, Wait } from "testcontainers";

let container: any;

export async function setup() {
  // Build image from core Dockerfile
  const builder = await GenericContainer.fromDockerfile("../../core").build(
    "agentified-core-test",
    { deleteOnExit: false },
  );

  container = await builder
    .withExposedPorts(9119)
    .withEnvironment({
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
      AGENTIFIED_PORT: "9119",
    })
    .withHealthCheck({
      test: ["CMD-SHELL", "curl -f http://localhost:9119/health || exit 1"],
      interval: 2_000,
      timeout: 3_000,
      retries: 30,
      startPeriod: 5_000,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(180_000)
    .start();

  const port = container.getMappedPort(9119);
  const host = container.getHost();
  process.env.AGENTIFIED_ENDPOINT = `http://${host}:${port}`;

  console.log(`Agentified Core running at ${process.env.AGENTIFIED_ENDPOINT}`);
}

export async function teardown() {
  await container?.stop();
}
