import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  assert.match(cfn, /raw\.githubusercontent\.com\/ratel-ai\/ratel\/\$\{Ref\}\/install\.sh" \| sh -s -- --yes/);
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
  assert.match(arm.variables.bootstrap, /ratel\/\$ref\/install\.sh" \| sh -s -- --yes/);
  assert.match(arm.variables.bootstrap, /needs a password of 12 characters or more/, "no public console with an empty password");
  for (const p of ["ref", "domain", "loginPassword", "accessMode"]) {
    assert.ok(arm.variables.bootstrap.includes(`base64(`) && arm.variables.bootstrap.match(new RegExp(`base64\\((concat\\()?parameters\\('${p}'\\)`)), `${p} reaches the script base64-encoded`);
  }
  const vm = arm.resources.find((r) => r.type === "Microsoft.Compute/virtualMachines");
  assert.equal(vm.properties.osProfile.customData, "[base64(variables('bootstrap'))]");
  assert.equal(vm.properties.osProfile.linuxConfiguration.disablePasswordAuthentication, true);
});
