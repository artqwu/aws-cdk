import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';

// import * as sqs from 'aws-cdk-lib/aws-sqs';

// extend the props of the stack by adding the vpc type from the SharedInfraStack
export interface EcsStackProps extends cdk.StackProps {
    vpc: ec2.Vpc;
}

export class EcsStack extends cdk.Stack {
    public readonly service: ecs.FargateService;

    private vpc: ec2.Vpc;

    constructor(scope: Construct, id: string, props: EcsStackProps) {
        super(scope, id, props);

        const vpc = props.vpc;

        // Create the web service ECS cluster
        const cluster = new ecs.Cluster(this, 'WebServiceCluster', {
            vpc,
        });

        // Create the Fargate task definition
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'web-sevice', {
            memoryLimitMiB: 16384,
            cpu: 4096,
        });

        // Add a container to the task definition
        const repo = ecr.Repository.fromRepositoryName(this, 'tdd-ecr', 'web-service');
        const tag = 'latest';
        const image = ecs.ContainerImage.fromEcrRepository(repo, tag);

        const container = taskDefinition.addContainer('WebServiceContainer', {
            image: image,
            portMappings: [{ containerPort: 443 }],
        });

        // Create the ECS service
        const service = new ecs.FargateService(this, 'web-service-service', {
            cluster,
            taskDefinition,
            desiredCount: 2,
            assignPublicIp: false,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        });

        this.service = service;
    }
}