import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { IEnvironmentConfig } from './environment-config';

// extend the props of the stack by adding the vpc type from the SharedInfraStack
export interface WebServiceStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}
export class WebServiceStack extends cdk.Stack {
  public readonly cluster: ecs_patterns.ApplicationLoadBalancedFargateService;
  private sqsTimeout: number = 300;

  constructor(scope: Construct, id: string, props: WebServiceStackProps) {
    super(scope, id, props);
    const account: string = props.env ? (props.env.account || '') : (process.env.CDK_DEFAULT_ACCOUNT || '');
    const envConfig: IEnvironmentConfig = scope.node.tryGetContext(account);

    // Use SQS managed server side encryption (SSE-SQS)
    const generateMenuQueue = new sqs.Queue(this, 'generate_menu', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(this.sqsTimeout)
    });
    const generateMenuPriorityQueue = new sqs.Queue(this, 'generate_menu_priority', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(this.sqsTimeout)
    });
    const generateMenuAlternativesQueue = new sqs.Queue(this, 'generate_menu_alternatives', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(this.sqsTimeout)
    });

    const ecsTaskRole = this.createEcsTaskRole_();

    const loadBalancedFargateService = this.createLoadBalancedFargateService_(
      props.vpc,
      ecsTaskRole,
      envConfig,
      generateMenuQueue.queueUrl,
      generateMenuPriorityQueue.queueUrl,
      generateMenuAlternativesQueue.queueUrl
    );

    // create a bastion host
    const host = new ec2.BastionHostLinux(this, 'BastionHost', {
      vpc: props.vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
    });
    // host.allowSshAccessFrom(ec2.Peer.ipv4('24.147.56.174/32'));
    host.allowSshAccessFrom(ec2.Peer.ipv4('0.0.0.0/0'));

    this.createARecord_(envConfig.hostedZoneId, envConfig.domain, loadBalancedFargateService.loadBalancer);

    const menuGenerateConsumer = this.createMenuGenerateConsumer_(
      props.vpc,
      envConfig.imageTag,
      generateMenuQueue,
      generateMenuPriorityQueue,
      generateMenuAlternativesQueue
    );
    const menuGenerateAlternativesConsumer = this.createMenuGenerateAlternativesConsumer_(
      props.vpc,
      envConfig.imageTag,
      generateMenuQueue,
      generateMenuPriorityQueue,
      generateMenuAlternativesQueue
    );

    const rdsInstance = this.createRdsInstance_(props.vpc);
    rdsInstance.grantConnect(ecsTaskRole);
    const tcp3306 = ec2.Port.tcpRange(3306, 3306);
    rdsInstance.connections.allowFrom(loadBalancedFargateService.service, tcp3306, 'allow from ecs service');
    rdsInstance.connections.allowFrom(host, tcp3306, 'allow from bastion host');
    rdsInstance.connections.allowFrom(menuGenerateConsumer, tcp3306, 'allow from menu generate lambda');
    rdsInstance.connections.allowFrom(menuGenerateAlternativesConsumer, tcp3306, 'allow from menu generate lambda');

    this.cluster = loadBalancedFargateService;
  }

  /**
   * Create ECS task role provisioned for ECS Exec connection
   * @returns
   */
  createEcsTaskRole_(): iam.Role {
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

    return taskRole;
  }

  createRdsInstance_(vpc: ec2.IVpc): rds.DatabaseInstance {
    return new rds.DatabaseInstance(this, 'SymfonyDb', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_5_7_38,
      }),
      backupRetention: cdk.Duration.days(7),
      allocatedStorage: 20,
      // optional, defaults to m5.large
      // instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.SMALL),
      credentials: rds.Credentials.fromGeneratedSecret('admin'), // Optional - will default to 'admin' username and generated password
      vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      storageEncrypted: true,
      monitoringInterval: cdk.Duration.seconds(60),
      publiclyAccessible: false,
    });
  }

  createLoadBalancedFargateService_(
    vpc: ec2.IVpc,
    taskRole: iam.Role,
    envConfig: IEnvironmentConfig,
    generateMenuQueueUrl: string,
    generateMenuPriorityQueueUrl: string,
    generateMenuAlternativesQueueUrl: string
  ): ecs_patterns.ApplicationLoadBalancedFargateService {
    const cpu = 4096; // Default is 256
    const memoryLimitMiB = 16384;
    const taskCount = 2;

    const cluster = new ecs.Cluster(this, "WebServiceCluster", {
      vpc
    });

    const repo = ecr.Repository.fromRepositoryName(this, 'ecr-web-service', 'web-service');
    const image = ecs.ContainerImage.fromEcrRepository(repo, envConfig.imageTag);
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', envConfig.certArn);

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
        MENU_GENERATE_QUEUE_URL: generateMenuQueueUrl,
        MENU_GENERATE_PRIORITY_QUEUE_URL: generateMenuPriorityQueueUrl,
        MENU_GENERATE_ALTERNATIVES_QUEUE_URL: generateMenuAlternativesQueueUrl,
      },
      logging: logDriver
    });

    // Create a load-balanced Fargate service and make it public
    const loadBalancedFargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "WebService", {
      cluster, // Required
      desiredCount: taskCount, // Default is 1
      taskDefinition,
      publicLoadBalancer: true, // Default is true
      certificate,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      targetProtocol: elbv2.ApplicationProtocol.HTTPS
    });

    loadBalancedFargateService.targetGroup.configureHealthCheck({
      path: "/app",
    });

    return loadBalancedFargateService;
  }

  /**
   * creates A record for the load balancer
   * @param hostedZoneId
   * @param domain
   * @param loadBalancer
   */
  createARecord_(hostedZoneId: string, domain: string, loadBalancer: elbv2.ILoadBalancerV2): void {
    const hostedZone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'WebServiceHostedZone', {
      hostedZoneId: hostedZoneId,
      zoneName: domain,
    });

    // Define the A record
    new route53.ARecord(this, 'WebServiceARecord', {
      zone: hostedZone,
      recordName: domain,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(loadBalancer))
    });
  }

  createMenuGenerateConsumer_(
    vpc: ec2.IVpc,
    imageTag: string,
    generateMenuQueue: sqs.IQueue,
    generateMenuPriorityQueue: sqs.IQueue,
    generateMenuAlternativesQueue: sqs.IQueue
  ): lambda.DockerImageFunction {
    const repo = ecr.Repository.fromRepositoryName(this, 'ecr-menu-generate', 'menu-generate');

    const lambdaFunction = new lambda.DockerImageFunction(this, 'MenuGenerate', {
      code: lambda.DockerImageCode.fromEcr(repo, {
        tagOrDigest: imageTag
      }),
      environment: {
        AWS_KEY_ID: process.env.AWS_KEY_ID || '',
        AWS_KEY_SECRET: process.env.AWS_KEY_SECRET || '',
        MENU_GENERATE_QUEUE_URL: generateMenuQueue.queueUrl,
        MENU_GENERATE_PRIORITY_QUEUE_URL: generateMenuPriorityQueue.queueUrl,
        MENU_GENERATE_ALTERNATIVES_QUEUE_URL: generateMenuAlternativesQueue.queueUrl,
      },
      memorySize: 2048,
      timeout: cdk.Duration.seconds(this.sqsTimeout),
      vpc,
    });

    // Create an SQS queue event source for the Lambda function
    const generateMenuEventSource = new SqsEventSource(generateMenuQueue);
    lambdaFunction.addEventSource(generateMenuEventSource);
    const generateMenuPriorityEventSource = new SqsEventSource(generateMenuPriorityQueue);
    lambdaFunction.addEventSource(generateMenuPriorityEventSource);

    return lambdaFunction;
  }

  createMenuGenerateAlternativesConsumer_(
    vpc: ec2.IVpc,
    imageTag: string,
    generateMenuQueue: sqs.IQueue,
    generateMenuPriorityQueue: sqs.IQueue,
    generateMenuAlternativesQueue: sqs.IQueue
  ): lambda.DockerImageFunction {
    const repo = ecr.Repository.fromRepositoryName(this, 'ecr-menu-generate-alternatives', 'menu-generate-alternatives');

    const lambdaFunction = new lambda.DockerImageFunction(this, 'MenuGenerateAlternatives', {
      code: lambda.DockerImageCode.fromEcr(repo, {
        tagOrDigest: imageTag
      }),
      environment: {
        AWS_KEY_ID: process.env.AWS_KEY_ID || '',
        AWS_KEY_SECRET: process.env.AWS_KEY_SECRET || '',
        MENU_GENERATE_QUEUE_URL: generateMenuQueue.queueUrl,
        MENU_GENERATE_PRIORITY_QUEUE_URL: generateMenuPriorityQueue.queueUrl,
        MENU_GENERATE_ALTERNATIVES_QUEUE_URL: generateMenuAlternativesQueue.queueUrl,
      },
      memorySize: 2048,
      timeout: cdk.Duration.seconds(this.sqsTimeout),
      vpc,
    });

    // Create an SQS queue event source for the Lambda function
    const generateMenuAlternativesEventSource = new SqsEventSource(generateMenuAlternativesQueue);
    lambdaFunction.addEventSource(generateMenuAlternativesEventSource);

    return lambdaFunction;
  }
}
