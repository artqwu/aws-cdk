import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

// extend the props of the stack by adding the vpc type from the SharedInfraStack
export interface FargateStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

export class FargateStack extends cdk.Stack {
  private vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: FargateStackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    const cluster = new ecs.Cluster(this, "WebServiceCluster", {
      vpc: props.vpc
    });

    const repo = ecr.Repository.fromRepositoryName(this, 'tdd-ecr', 'web-service');
    const tag = '0.0.84';
    const image = ecs.ContainerImage.fromEcrRepository(repo, tag);
    const certArn = 'arn:aws:acm:us-east-2:962199888341:certificate/d5f3d620-8561-485b-9478-c0bc787b1b43';
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', certArn);

    // Create a load-balanced Fargate service and make it public
    const loadBalancedFargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "MyFargateService", {
      cluster: cluster, // Required
      cpu: 4096, // Default is 256
      desiredCount: 2, // Default is 1
      taskImageOptions: {
        image: image,
        containerPort: 443
      },
      memoryLimitMiB: 16384, // Default is 512
      publicLoadBalancer: true, // Default is true
      certificate: certificate,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      targetProtocol: elbv2.ApplicationProtocol.HTTPS
    });

    loadBalancedFargateService.targetGroup.configureHealthCheck({
      path: "/app",
    });

    // example resource
    // const queue = new sqs.Queue(this, 'SrcQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
