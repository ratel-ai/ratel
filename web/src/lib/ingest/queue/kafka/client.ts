import { Kafka, type KafkaConfig, logLevel } from "kafkajs";
import { getLogger } from "@/lib/platform/logger";

const logger = getLogger("ingest:kafka");

export type KafkaSecurity = "plaintext" | "tls" | "iam";

export interface KafkaConnection {
  brokers: string[];
  security: KafkaSecurity;
  /** The AWS region of `iam`. */
  region?: string;
}

const LEVELS = {
  [logLevel.NOTHING]: "silent",
  [logLevel.ERROR]: "error",
  [logLevel.WARN]: "warn",
  [logLevel.INFO]: "info",
  [logLevel.DEBUG]: "debug",
} as const;

export async function createKafkaClient({
  brokers,
  security,
  region,
}: KafkaConnection): Promise<Kafka> {
  return new Kafka({
    clientId: "ratel-ingest",
    brokers,
    connectionTimeout: 5_000,
    requestTimeout: 8_000,
    // A publish answers within 10 s (ADR-0009), so the client gives up before that.
    retry: { initialRetryTime: 200, maxRetryTime: 2_000, retries: 4 },
    logLevel: logLevel.WARN,
    logCreator: () => (entry) => {
      const level = LEVELS[entry.level];
      if (level === "silent") return;
      const { message, error, groupId, broker } = entry.log;
      logger[level]({ error, groupId, broker }, message);
    },
    ...(security === "plaintext" ? {} : { ssl: true }),
    ...(security === "iam" ? { sasl: await iamSasl(region) } : {}),
  });
}

/** Amazon MSK's IAM login: a token signed by the AWS credential chain (the task role). */
async function iamSasl(region: string | undefined): Promise<KafkaConfig["sasl"]> {
  if (!region) throw new Error("INGEST_KAFKA_SECURITY=iam needs INGEST_KAFKA_REGION");
  const { generateAuthToken } = await import("aws-msk-iam-sasl-signer-js");
  return {
    mechanism: "oauthbearer",
    oauthBearerProvider: async () => ({ value: (await generateAuthToken({ region })).token }),
  };
}
