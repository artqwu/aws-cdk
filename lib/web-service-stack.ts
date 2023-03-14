import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

// extend the props of the stack by adding the vpc type from the SharedInfraStack
export interface WebServiceStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

export class WebServiceStack extends cdk.Stack {
  private vpc: ec2.Vpc;

  public readonly cluster: ecs_patterns.ApplicationLoadBalancedFargateService;

  constructor(scope: Construct, id: string, props: WebServiceStackProps) {
    super(scope, id, props);

    const hostedZoneId = 'Z010453623RVJF2NPOIVD';
    const domain = 'db.aws-dev.thedinnerdaily.com';
    const cpu = 4096; // Default is 256
    const memoryLimitMiB = 16384;

    // Use SQS managed server side encryption (SSE-SQS)
    const generateMenuQueue = new sqs.Queue(this, 'generate_menu', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(30)
    });
    const generateMenuPriorityQueue = new sqs.Queue(this, 'generate_menu_priority', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(30)
    });
    const generateMenuAlternativesQueue = new sqs.Queue(this, 'generate_menu_alternatives', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(30)
    });

    const rdsInstance = new rds.DatabaseInstance(this, 'SymfonyDb', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_5_7_38,
      }),
      backupRetention: cdk.Duration.days(7),
      allocatedStorage: 20,
      // optional, defaults to m5.large
      // instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.SMALL),
      credentials: rds.Credentials.fromGeneratedSecret('admin'), // Optional - will default to 'admin' username and generated password
      vpc: props.vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      storageEncrypted: true,
      monitoringInterval: cdk.Duration.seconds(60),
      publiclyAccessible: false,
    });

    // Create ECS task execution role provisioned for ECS Exec connection
    const taskRole = new iam.Role(this, 'EcsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'));
    taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonRDSDataFullAccess'));
    taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSQSFullAccess'));
    taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadWrite'));
    taskRole.addToPolicy(new iam.PolicyStatement({
      resources: ['*'],
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel'
      ],
      effect: iam.Effect.ALLOW
    }));
    rdsInstance.grantConnect(taskRole);

    // The code that defines your stack goes here
    const cluster = new ecs.Cluster(this, "WebServiceCluster", {
      vpc: props.vpc
    });

    const repo = ecr.Repository.fromRepositoryName(this, 'tdd-ecr', 'web-service');
    const tag = '0.0.86';
    const image = ecs.ContainerImage.fromEcrRepository(repo, tag);
    const certArn = 'arn:aws:acm:us-east-2:962199888341:certificate/d5f3d620-8561-485b-9478-c0bc787b1b43';
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', certArn);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'WebServiceTaskDefinition', {
      taskRole,
      cpu,
      memoryLimitMiB,
    });

    const logDriver = ecs.LogDriver.awsLogs({
      streamPrefix: 'web-service'
    });

    taskDefinition.addContainer('WebContainer', {
      cpu,
      image,
      memoryLimitMiB,
      portMappings: [{ containerPort: 443 }],
      environment: {
        AWS_KEY_ID: process.env.AWS_KEY_ID || '',
        AWS_KEY_SECRET: process.env.AWS_KEY_SECRET || '',
        MENU_GENERATE_QUEUE_URL: generateMenuQueue.queueUrl,
        MENU_GENERATE_PRIORITY_QUEUE_URL: generateMenuPriorityQueue.queueUrl,
        MENU_GENERATE_ALTERNATIVES_QUEUE_URL: generateMenuAlternativesQueue.queueUrl,
      },
      logging: logDriver
    });

    // Create a load-balanced Fargate service and make it public
    const loadBalancedFargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "WebService", {
      cluster: cluster, // Required
      desiredCount: 2, // Default is 1
      taskDefinition: taskDefinition,
      publicLoadBalancer: true, // Default is true
      certificate: certificate,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      targetProtocol: elbv2.ApplicationProtocol.HTTPS
    });

    loadBalancedFargateService.targetGroup.configureHealthCheck({
      path: "/app",
    });

    // create a bastion host
    const host = new ec2.BastionHostLinux(this, 'BastionHost', {
      vpc: props.vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
    });
    // host.allowSshAccessFrom(ec2.Peer.ipv4('24.147.56.174/32'));
    host.allowSshAccessFrom(ec2.Peer.ipv4('0.0.0.0/0'));

    const hostedZone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'WebServiceHostedZone', {
      hostedZoneId,
      zoneName: domain,
    });
    // Define the A record
       new route53.ARecord(this, 'WebServiceARecord', {
      zone: hostedZone,
      recordName: domain,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(loadBalancedFargateService.loadBalancer)),
    });

    const tcp3306 = ec2.Port.tcpRange(3306, 3306);
    rdsInstance.connections.allowFrom(loadBalancedFargateService.service, tcp3306, 'allow from ecs service');
    rdsInstance.connections.allowFrom(host, tcp3306, 'allow from bastion host');

    this.cluster = loadBalancedFargateService;
  }
}
