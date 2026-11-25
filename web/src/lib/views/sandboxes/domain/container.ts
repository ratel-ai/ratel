/** How an image and an instance are put together, as shell that any container service can run. */

export const APP_DIR = "/app";
export const RUNNER_DIR = ".ratel-sandbox-runner";
export const BUNDLE_PATH = "/tmp/ratel-bundle.tar.gz";

/** The main process of an instance, in {@link APP_DIR}. */
export const RUN_COMMAND = [
  "node",
  "--disable-warning=ExperimentalWarning",
  `${APP_DIR}/${RUNNER_DIR}/run.js`,
];

export type BuildStep = { label: string; script: string };

/** The steps of a build, after the bundle is at {@link BUNDLE_PATH}. */
export function buildSteps(request: {
  install: readonly string[];
  entry: string;
  sha256: string;
}): BuildStep[] {
  const inApp = (script: string) => `cd ${APP_DIR}\n${script}`;
  return [
    {
      label: "checking the bundle",
      script: `echo "${request.sha256}  ${BUNDLE_PATH}" | sha256sum -c - >/dev/null`,
    },
    {
      label: "unpacking the bundle",
      script: `mkdir -p ${APP_DIR}\ntar -xzf ${BUNDLE_PATH} -C ${APP_DIR}\nrm -f ${BUNDLE_PATH}`,
    },
    ...request.install.map((command, index) => ({
      label: `install command ${index + 1} (${command})`,
      script: inApp(command),
    })),
    {
      label: "checking the entry point",
      script: inApp(`test -f ${shellQuote(request.entry)}`),
    },
    {
      label: "checking the runner of @ratel-ai/sandbox in the bundle",
      script: inApp(`test -f ${RUNNER_DIR}/run.js`),
    },
    {
      label: "checking that the base image has Node 22.18 or later",
      script: `node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'`,
    },
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
