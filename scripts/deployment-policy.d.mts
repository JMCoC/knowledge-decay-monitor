export type DeploymentTarget = {
  target: "production";
  sha: string;
};

export type DeploymentPolicyInput = {
  eventName: string;
  ref: string;
  qualityResult: string;
  testedSha: string;
  headSha: string;
  repository: string;
  authorizedActor: boolean;
};

export function chooseDeployment(input: DeploymentPolicyInput): DeploymentTarget | null;
