const ACRONYMS = new Set([
  "ec2", "alb", "eks", "ecs", "rds", "sqs", "asg", "elb", "nlb",
  "iam", "vpc", "s3", "aws", "oom", "api", "acl", "arn", "ebs",
  "efs", "sns", "ssm", "ami", "pr", "id", "url", "cpu", "az"
]);

const SPECIAL: Record<string, string> = {
  elasticache: "ElastiCache",
  lightsail: "Lightsail",
  fargate: "Fargate",
  lambda: "Lambda",
  cloudtrail: "CloudTrail",
};

export function formatLabel(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => {
      const lo = word.toLowerCase();
      if (ACRONYMS.has(lo)) return lo.toUpperCase();
      if (SPECIAL[lo]) return SPECIAL[lo];
      // HTTP status classes: 5xx -> 5XX, 4xx -> 4XX
      if (/^\d+xx$/.test(lo)) return lo.toUpperCase();
      return lo.charAt(0).toUpperCase() + lo.slice(1);
    })
    .join(" ");
}
