export type DeploymentTarget = {
  target: "preview" | "production";
  sha: string;
  prNumber?: number;
};

export type DeploymentPolicyInput = {
  eventName: string;
  ref: string;
  qualityResult: string;
  testedSha: string;
  headSha: string;
  headRepository?: string;
  repository: string;
  prState?: "open" | "closed";
  draft?: boolean;
  prNumber?: number;
  authorizedActor: boolean;
};

export function chooseDeployment(input: DeploymentPolicyInput): DeploymentTarget | null;
