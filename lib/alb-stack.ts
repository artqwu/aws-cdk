import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface AlbStackProps extends cdk.StackProps {
    vpc: ec2.Vpc;
    ecsService: ecs.FargateService;
}

export class AlbStack extends cdk.Stack {
    private vpc: ec2.Vpc;
    private ecsService: ecs.FargateService;

    constructor(scope: Construct, id: string, props: AlbStackProps) {
        super(scope, id, props);

        const vpc = props.vpc;
        const service = props.ecsService;

        // Create the ALB
        const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
            vpc,
            internetFacing: true,
        });

        // Create a listener for the ALB
        const listener = alb.addListener('Listener', {
            port: 443,
        });
        listener.addCertificates('Certificate', [
            {
                certificateArn: 'arn:aws:acm:us-east-2:962199888341:certificate/d5f3d620-8561-485b-9478-c0bc787b1b43',
            },
        ]);

        // Create a target group for the ECS service
        const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
            vpc,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            targets: [service],
            port: 443,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                enabled: true,
                path: '/app',
            }
        });

        // Add the target group to the listener
        listener.addTargetGroups('TargetGroups', {
            targetGroups: [targetGroup]
        });

        // Output the load balancer DNS name
        new cdk.CfnOutput(this, 'LoadBalancerDNS', {
            value: alb.loadBalancerDnsName,
        });
    }
}
