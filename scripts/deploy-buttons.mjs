// The README's one-click deploy buttons. Each one starts install.sh on a new VM in the user's
// cloud: AWS through deploy/cloudformation, Azure through deploy/azure, Google Cloud through
// deploy.sh in Cloud Shell. `node scripts/deploy-buttons.mjs` prints the README markdown.

const REPO = "https://github.com/ratel-ai/ratel";
const RAW = "https://raw.githubusercontent.com/ratel-ai/ratel/main";

// The public bucket that .github/workflows/deploy-templates.yml uploads the template to.
// CloudFormation takes a template URL only from S3.
export const TEMPLATE_BUCKET = "ratel-public-templates";

export const BUTTONS = [
  {
    cloud: "AWS",
    url: awsLaunchStackUrl(),
    image: "https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png",
    alt: "Launch Stack",
  },
  { cloud: "Azure", url: azureDeployUrl(), image: "https://aka.ms/deploytoazurebutton", alt: "Deploy to Azure" },
  {
    cloud: "Google Cloud",
    url: cloudShellUrl(),
    image: "https://gstatic.com/cloudssh/images/open-btn.svg",
    alt: "Open in Cloud Shell",
  },
].map((b) => ({ ...b, markdown: `[![${b.alt}](${b.image})](${b.url})` }));

export function awsLaunchStackUrl() {
  const template = `https://${TEMPLATE_BUCKET}.s3.amazonaws.com/cloudformation/ratel.yaml`;
  const query = new URLSearchParams({ templateURL: template, stackName: "ratel" });
  return `https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?${query}`;
}

export function azureDeployUrl() {
  return `https://portal.azure.com/#create/Microsoft.Template/uri/${encodeURIComponent(`${RAW}/deploy/azure/azuredeploy.json`)}`;
}

export function cloudShellUrl() {
  const query = new URLSearchParams({
    cloudshell_git_repo: REPO,
    cloudshell_git_branch: "main",
    cloudshell_tutorial: "deploy/cloudshell/tutorial.md",
    show: "terminal",
  });
  return `https://shell.cloud.google.com/cloudshell/editor?${query}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const b of BUTTONS) console.log(`${b.cloud}: ${b.markdown}`);
}
