import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class EcsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, "MyVpc", {
            cidr: '10.0.0.0/16',
            maxAzs: 2,
            subnetConfiguration: [
              {
                name: 'Public',
                subnetType: ec2.SubnetType.PUBLIC,
                cidrMask: 24,
              },
              {
                name: 'Private',
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                cidrMask: 24,
              }
            ],
          });

          const cluster = new ecs.Cluster(this, "WebServiceCluster", {
            vpc: vpc
          });

          const repo = ecr.Repository.fromRepositoryName(this, 'tdd-ecr', 'web-service');
          const tag = 'latest';
          const image = ecs.ContainerImage.fromEcrRepository(repo, tag);
          const certArn = 'arn:aws:acm:us-east-2:962199888341:certificate/d5f3d620-8561-485b-9478-c0bc787b1b43';
          const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', certArn);

          // Create a load-balanced Fargate service and make it public
          const loadBalancedFargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "MyFargateService", {
            cluster: cluster, // Required
            cpu: 4096, // Default is 256
            desiredCount: 2, // Default is 1
            taskImageOptions: { image: image },
            memoryLimitMiB: 16384, // Default is 512
            publicLoadBalancer: true, // Default is true
            certificate: certificate,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            targetProtocol: elbv2.ApplicationProtocol.HTTP
          });

          loadBalancedFargateService.targetGroup.configureHealthCheck({
            path: "/app",
          });
    }
}