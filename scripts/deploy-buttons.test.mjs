import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BUTTONS, TEMPLATE_BUCKET, awsLaunchStackUrl, azureDeployUrl, cloudShellUrl } from "./deploy-buttons.mjs";

const repo = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path) => readFileSync(repo(path), "utf8");

test("Launch Stack opens the quick-create page with the template from S3", () => {
  const url = new URL(awsLaunchStackUrl());
  assert.equal(url.origin, "https://console.aws.amazon.com");
  const [route, query] = url.hash.slice(1).split("?");
  assert.equal(route, "/stacks/quickcreate");
  const params = new URLSearchParams(query);
  assert.equal(params.get("stackName"), "ratel");
  assert.equal(params.get("templateURL"), `https://${TEMPLATE_BUCKET}.s3.amazonaws.com/cloudformation/ratel.yaml`);
});

test("Deploy to Azure opens the portal with the template's raw GitHub URL", () => {
  const prefix = "https://portal.azure.com/#create/Microsoft.Template/uri/";
  const url = azureDeployUrl();
  assert.ok(url.startsWith(prefix));
  assert.equal(
    decodeURIComponent(url.slice(prefix.length)),
    "https://raw.githubusercontent.com/ratel-ai/ratel/main/deploy/azure/azuredeploy.json",
  );
});

test("Open in Cloud Shell clones the repo and opens the tutorial, which exists", () => {
  const params = new URL(cloudShellUrl()).searchParams;
  assert.equal(params.get("cloudshell_git_repo"), "https://github.com/ratel-ai/ratel");
  assert.equal(params.get("cloudshell_git_branch"), "main");
  assert.ok(existsSync(repo(params.get("cloudshell_tutorial"))));
  assert.match(read(params.get("cloudshell_tutorial")), /\.\/deploy\.sh up --cloud gcp/);
});

test("the README shows each button with its generated link", () => {
  const readme = read("README.md");
  for (const { markdown } of BUTTONS) assert.ok(readme.includes(markdown), markdown);
});

test("the CloudFormation template runs install.sh with both access modes and hides the password", () => {
  const cfn = read("deploy/cloudformation/ratel.yaml");
  assert.match(cfn, /ratel-ai\/ratel\/\$branch\/install\.sh" \| sh -s -- --yes \$args/);
  assert.match(cfn, /args="--version '\$\{Version\}'|args="--version \$\{Version\}"/);
  assert.match(cfn, /AllowedValues: \[public, private\]/);
  assert.match(cfn, /LoginPassword:\n\s+Type: String\n\s+NoEcho: true/);
  assert.match(cfn, /--auth-hash \$hash/);
  assert.doesNotMatch(cfn, /--auth-hash[^\n]*LoginPassword/, "only the hash reaches install.sh");
});

test("the ARM template runs install.sh with both access modes and takes the password as a secure string", () => {
  const arm = JSON.parse(read("deploy/azure/azuredeploy.json"));
  assert.match(arm.$schema, /deploymentTemplate\.json#$/);
  assert.equal(arm.parameters.loginPassword.type, "secureString");
  assert.deepEqual(arm.parameters.accessMode.allowedValues, ["public", "private"]);
  assert.equal(arm.parameters.accessMode.defaultValue, "public");
  assert.match(arm.variables.bootstrap, /ratel\/\$branch\/install\.sh" \| sh -s -- --yes/);
  assert.match(arm.variables.bootstrap, /needs a password of 12 characters or more/, "no public console with an empty password");
  for (const p of ["version", "ref", "domain", "loginPassword", "accessMode"]) {
    assert.ok(arm.variables.bootstrap.includes(`base64(`) && arm.variables.bootstrap.match(new RegExp(`base64\\((concat\\()?parameters\\('${p}'\\)`)), `${p} reaches the script base64-encoded`);
  }
  const vm = arm.resources.find((r) => r.type === "Microsoft.Compute/virtualMachines");
  assert.equal(vm.properties.osProfile.customData, "[base64(variables('bootstrap'))]");
  assert.equal(vm.properties.osProfile.linuxConfiguration.disablePasswordAuthentication, true);
});

test("the CloudFormation Ref pattern rejects a ref with ..", () => {
  const cfn = read("deploy/cloudformation/ratel.yaml");
  const block = cfn.slice(cfn.indexOf("\n  Ref:\n"));
  const pattern = new RegExp(JSON.parse(block.match(/AllowedPattern: (".*")/)[1]));
  assert.ok(pattern.test("v1.2.3") && pattern.test("feat/x"));
  for (const ref of ["main/../../evil", "..", "a..b"]) assert.ok(!pattern.test(ref), ref);
});

test("the CloudFormation Version pattern takes a release, latest or edge, and nothing else", () => {
  const cfn = read("deploy/cloudformation/ratel.yaml");
  const block = cfn.slice(cfn.indexOf("\n  Version:\n"));
  assert.match(block, /Default: latest/);
  const pattern = new RegExp(JSON.parse(block.match(/AllowedPattern: (".*")/)[1]));
  for (const ok of ["latest", "edge", "0.4.0", "0.4.0-rc.1"]) assert.ok(pattern.test(ok), ok);
  for (const bad of ["", "main", "v0.4", "0.4.0;id", "$(id)"]) assert.ok(!pattern.test(bad), bad);
});

const armRun = (input) => {
  const arm = JSON.parse(read("deploy/azure/azuredeploy.json"));
  const b64 = (v) => Buffer.from(v).toString("base64");
  const values = { accessMode: "private", version: "latest", ref: "", domain: "", loginPassword: "", ...input };
  // Render the concat(): each string literal as is, each base64(...parameters('x')...) with the value.
  const tokens = arm.variables.bootstrap
    .slice("[concat(".length, -")]".length)
    .match(/'(?:[^']|'')*'|base64\((?:concat\()?parameters\('\w+'\)(?:, '')?\)\)?|variables\('tls'\)/g);
  const script = tokens
    .map((t) => {
      if (t.startsWith("'")) return t.slice(1, -1).replaceAll("''", "'");
      if (t.startsWith("variables")) return "acme";
      return b64(values[t.match(/parameters\('(\w+)'\)/)[1]]);
    })
    .join("");
  assert.match(script, /^#!\/bin\/sh\n/);
  // curl is a fake that prints an install.sh printing its arguments, so nothing is downloaded.
  const bin = mkdtempSync(join(tmpdir(), "ratel-arm-"));
  writeFileSync(join(bin, "curl"), `#!/bin/sh\necho 'echo "$@"'\n`, { mode: 0o755 });
  return spawnSync("sh", ["-c", script], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
};

test("the ARM bootstrap stops on a bad ref or version before it installs anything", () => {
  for (const [input, message] of [
    [{ ref: "main/../../evil" }, /bad ref/],
    [{ version: "0.4.0;id" }, /bad version/],
    [{ version: "" }, /bad version/],
  ]) {
    const run = armRun(input);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, message);
  }
});

test("the ARM bootstrap passes the version, or the ref when one is set", () => {
  assert.match(armRun({}).stdout, /--version latest --dir \/opt\/ratel/);
  assert.match(armRun({ version: "0.4.0" }).stdout, /--version 0\.4\.0 --dir/);
  assert.match(armRun({ ref: "feat/x" }).stdout, /--ref feat\/x --dir/);
});
