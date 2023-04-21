import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as os from 'aws-cdk-lib/aws-opensearchservice';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as r53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { IEnvironmentConfig } from './environment-config';

// extend the props of the stack by adding the vpc type from the SharedInfraStack
export interface WebServiceStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}
export class WebServiceStack extends cdk.Stack {
  public readonly cluster: ecs_patterns.ApplicationLoadBalancedFargateService;
  public readonly identity: iam.IGrantable;

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

    const defaultSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'DefaultSecurityGroup', props.vpc.vpcDefaultSecurityGroup);
    const ecsTaskRole = this.createEcsTaskRole_();
    const openSearchDomain = this.createOpenSearchDomain_(props.vpc, defaultSecurityGroup, ecsTaskRole);
    const fileSystem = this.createEfs_(props.vpc);
    const efsAccessPoint = this.createEfsAccessPoint_(fileSystem);

    const loadBalancedFargateService = this.createLoadBalancedFargateService_(
      props.vpc,
      defaultSecurityGroup,
      ecsTaskRole,
      envConfig,
      fileSystem,
      efsAccessPoint,
      generateMenuQueue.queueUrl,
      generateMenuPriorityQueue.queueUrl,
      generateMenuAlternativesQueue.queueUrl,
      openSearchDomain.domainEndpoint
    );

    this.createARecord_(envConfig.hostedZoneId, envConfig.domain, loadBalancedFargateService.loadBalancer);

    const menuGenerateConsumer = this.createMenuGenerateConsumer_(
      props.vpc,
      defaultSecurityGroup,
      envConfig.imageTag,
      generateMenuQueue,
      generateMenuPriorityQueue,
      generateMenuAlternativesQueue
    );
    const menuGenerateAlternativesConsumer = this.createMenuGenerateAlternativesConsumer_(
      props.vpc,
      defaultSecurityGroup,
      envConfig.imageTag,
      generateMenuQueue,
      generateMenuPriorityQueue,
      generateMenuAlternativesQueue
    );

    const menuScheduler = this.createMenuScheduler_(
      props.vpc,
      defaultSecurityGroup,
      envConfig.imageTag,
      generateMenuQueue,
      generateMenuPriorityQueue,
      generateMenuAlternativesQueue
    );

    const scheduleExecutor = this.createScheduleExecutor_(
      props.vpc,
      defaultSecurityGroup,
      envConfig.imageTag,
      generateMenuQueue,
      generateMenuPriorityQueue,
      generateMenuAlternativesQueue
    );

    this.cluster = loadBalancedFargateService;
    this.identity = ecsTaskRole.grantPrincipal;
  }

  createEfs_(vpc: ec2.IVpc): efs.FileSystem {
    // Create an EFS file system
    const fileSystem = new efs.FileSystem(this, 'WebFileSystem', {
      fileSystemName: 'WebFileSystem',
      vpc,
      encrypted: true
    });

    return fileSystem;
  }

  createEfsAccessPoint_(fileSystem: efs.FileSystem): efs.AccessPoint {
    // Create an EFS access point
    const efsAccessPoint = fileSystem.addAccessPoint('WebAccessPoint', {
      path: '/ecs',
      createAcl: {
        ownerUid: '1000',
        ownerGid: '1000',
        permissions: '777',
      },
      posixUser: {
        uid: '1000',
        gid: '1000',
      }
    });

    return efsAccessPoint;
  }

  /**
   * Create ECS task role provisioned for ECS Exec connection
   * @returns
   */
  createEcsTaskRole_(): iam.Role {
    const taskRole = new iam.Role(this, 'EcsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonOpenSearchServiceFullAccess'));
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

  createOpenSearchDomain_(
    vpc: ec2.IVpc,
    vpcSecurityGroup: ec2.ISecurityGroup,
    identity: iam.IGrantable
  ): os.Domain {
    const domainProps: os.DomainProps = {
      version: os.EngineVersion.OPENSEARCH_2_3,
      useUnsignedBasicAuth: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      vpc,
      securityGroups: [vpcSecurityGroup],
      capacity: {
        dataNodes: 2,
      },
      ebs: {
        volumeSize: 10,
      },
      zoneAwareness: {
        enabled: true
      },
      logging: {
        slowSearchLogEnabled: true,
        appLogEnabled: true,
        slowIndexLogEnabled: true,
      },
    };

    const domain = new os.Domain(this, 'recipes', domainProps);
    domain.grantRead(identity);
    domain.grantWrite(identity);

    return domain;
  }

  createLoadBalancedFargateService_(
    vpc: ec2.IVpc,
    vpcSecurityGroup: ec2.ISecurityGroup,
    taskRole: iam.Role,
    envConfig: IEnvironmentConfig,
    fileSystem: efs.FileSystem,
    efsAccessPoint: efs.AccessPoint,
    generateMenuQueueUrl: string,
    generateMenuPriorityQueueUrl: string,
    generateMenuAlternativesQueueUrl: string,
    openSearchEndpoint: string
  ): ecs_patterns.ApplicationLoadBalancedFargateService {
    const cpu = 4096; // Default is 256
    const memoryLimitMiB = 16384;
    const taskCount = 1;
    const maxTaskCount = 2;
    const relativeEfsPath = 'web/uploads/media';
    const absoluteEfsPath = `/var/www/html/${relativeEfsPath}`;
    const efsVolumeName = 'efs-server-AP';

    const cluster = new ecs.Cluster(this, "WebServiceCluster", {
      vpc
    });

    const repo = ecr.Repository.fromRepositoryName(this, 'ecr-web-service', 'web-service');
    const image = ecs.ContainerImage.fromEcrRepository(repo, envConfig.imageTag);
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', envConfig.certArn);

    // Attach an EFS policy to the task role
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite',
        'elasticfilesystem:DescribeMountTargets'
      ],
      resources: [
        fileSystem.fileSystemArn,
      ],
    }));

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'WebServiceTaskDefinition', {
      taskRole,
      cpu,
      memoryLimitMiB,
    });

    // add task definition to mount EFS
    taskDefinition.addVolume({
      name: efsVolumeName,
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          iam: 'ENABLED',
          accessPointId: efsAccessPoint.accessPointId,
        }
      },
    });

    const logDriver = ecs.LogDriver.awsLogs({
      streamPrefix: 'web-service'
    });

    const containerDefinition = taskDefinition.addContainer('WebContainer', {
      cpu,
      image,
      memoryLimitMiB,
      portMappings: [{ containerPort: 443 }],
      environment: {
        AWS_KEY_ID: process.env.AWS_KEY_ID || '',
        AWS_KEY_SECRET: process.env.AWS_KEY_SECRET || '',
        EFS_ACCESS_POINT_ID: efsAccessPoint.accessPointId,
        EFS_MOUNT_POINT: relativeEfsPath,
        EFS_ID: fileSystem.fileSystemId,
        MENU_GENERATE_QUEUE_URL: generateMenuQueueUrl,
        MENU_GENERATE_PRIORITY_QUEUE_URL: generateMenuPriorityQueueUrl,
        MENU_GENERATE_ALTERNATIVES_QUEUE_URL: generateMenuAlternativesQueueUrl,
        OPEN_SEARCH_ENDPOINT: openSearchEndpoint
      },
      logging: logDriver
    });

    // Add a mount point to the container definition
    const mountPoint: ecs.MountPoint = {
      containerPath: absoluteEfsPath,
      readOnly: false,
      sourceVolume: efsVolumeName,
    };
    containerDefinition.addMountPoints(mountPoint);

    // Create a load-balanced Fargate service and make it public
    const loadBalancedFargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "WebService", {
      cluster, // Required
      desiredCount: taskCount, // Default is 1
      taskDefinition,
      publicLoadBalancer: true, // Default is true
      certificate,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      targetProtocol: elbv2.ApplicationProtocol.HTTPS,
      securityGroups: [vpcSecurityGroup]
    });

    // Setup AutoScaling policy
    const scaling = loadBalancedFargateService.service.autoScaleTaskCount({ maxCapacity: maxTaskCount });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 50,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60)
    });

    fileSystem.connections.allowDefaultPortFrom(loadBalancedFargateService.service.connections);

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
      target: route53.RecordTarget.fromAlias(new r53_targets.LoadBalancerTarget(loadBalancer))
    });
  }

  addCommonLambdaPolicies_(lambdaFunction: lambda.Function): void {
    if (lambdaFunction.role) {
      lambdaFunction.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadWrite'));
      lambdaFunction.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonRDSDataFullAccess'));
    }
  }

  addSqsLambdaPolicies_(lambdaFunction: lambda.Function): void {
    this.addCommonLambdaPolicies_(lambdaFunction);
    if (lambdaFunction.role) {
      lambdaFunction.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonDynamoDBFullAccess'));
      lambdaFunction.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaSQSQueueExecutionRole'));
    }
  }

  createMenuGenerateConsumer_(
    vpc: ec2.IVpc,
    vpcSecurityGroup: ec2.ISecurityGroup,
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
        OPEN_SEARCH_ENDPOINT: 'openSearchEndpoint'
      },
      memorySize: 2048,
      timeout: cdk.Duration.seconds(this.sqsTimeout),
      vpc,
      securityGroups: [vpcSecurityGroup]
    });

    this.addSqsLambdaPolicies_(lambdaFunction);

    // Create an SQS queue event source for the Lambda function
    const generateMenuEventSource = new SqsEventSource(generateMenuQueue);
    lambdaFunction.addEventSource(generateMenuEventSource);
    const generateMenuPriorityEventSource = new SqsEventSource(generateMenuPriorityQueue);
    lambdaFunction.addEventSource(generateMenuPriorityEventSource);

    return lambdaFunction;
  }

  createMenuGenerateAlternativesConsumer_(
    vpc: ec2.IVpc,
    vpcSecurityGroup: ec2.ISecurityGroup,
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
        OPEN_SEARCH_ENDPOINT: 'openSearchEndpoint'
      },
      memorySize: 2048,
      timeout: cdk.Duration.seconds(this.sqsTimeout),
      vpc,
      securityGroups: [vpcSecurityGroup]
    });

    this.addSqsLambdaPolicies_(lambdaFunction);

    // Create an SQS queue event source for the Lambda function
    const generateMenuAlternativesEventSource = new SqsEventSource(generateMenuAlternativesQueue);
    lambdaFunction.addEventSource(generateMenuAlternativesEventSource);

    return lambdaFunction;
  }

  createMenuScheduler_(
    vpc: ec2.IVpc,
    vpcSecurityGroup: ec2.ISecurityGroup,
    imageTag: string,
    generateMenuQueue: sqs.IQueue,
    generateMenuPriorityQueue: sqs.IQueue,
    generateMenuAlternativesQueue: sqs.IQueue
  ): lambda.DockerImageFunction {
    const rateMin = 20;  // Run every 20 minutes

    const repo = ecr.Repository.fromRepositoryName(this, 'ecr-schedule-menu', 'schedule-menu');

    const lambdaFunction = new lambda.DockerImageFunction(this, 'ScheduleMenu', {
      code: lambda.DockerImageCode.fromEcr(repo, {
        tagOrDigest: imageTag
      }),
      environment: {
        AWS_KEY_ID: process.env.AWS_KEY_ID || '',
        AWS_KEY_SECRET: process.env.AWS_KEY_SECRET || '',
        MENU_GENERATE_QUEUE_URL: generateMenuQueue.queueUrl,
        MENU_GENERATE_PRIORITY_QUEUE_URL: generateMenuPriorityQueue.queueUrl,
        MENU_GENERATE_ALTERNATIVES_QUEUE_URL: generateMenuAlternativesQueue.queueUrl,
        OPEN_SEARCH_ENDPOINT: 'openSearchEndpoint'
      },
      memorySize: 512,
      timeout: cdk.Duration.seconds(this.sqsTimeout),
      vpc,
      securityGroups: [vpcSecurityGroup]
    });

    this.addCommonLambdaPolicies_(lambdaFunction);

    new events.Rule(this, 'ScheduleMenuRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(rateMin)),
      targets: [new events_targets.LambdaFunction(lambdaFunction)],
    });

    return lambdaFunction;
  }

  createScheduleExecutor_(
    vpc: ec2.IVpc,
    vpcSecurityGroup: ec2.ISecurityGroup,
    imageTag: string,
    generateMenuQueue: sqs.IQueue,
    generateMenuPriorityQueue: sqs.IQueue,
    generateMenuAlternativesQueue: sqs.IQueue
  ): lambda.DockerImageFunction {
    const rateMin = 10;  // Run every 20 minutes

    const repo = ecr.Repository.fromRepositoryName(this, 'ecr-execute-schedule', 'execute-schedule');

    const lambdaFunction = new lambda.DockerImageFunction(this, 'ExecuteSchedule', {
      code: lambda.DockerImageCode.fromEcr(repo, {
        tagOrDigest: imageTag
      }),
      environment: {
        AWS_KEY_ID: process.env.AWS_KEY_ID || '',
        AWS_KEY_SECRET: process.env.AWS_KEY_SECRET || '',
        MENU_GENERATE_QUEUE_URL: generateMenuQueue.queueUrl,
        MENU_GENERATE_PRIORITY_QUEUE_URL: generateMenuPriorityQueue.queueUrl,
        MENU_GENERATE_ALTERNATIVES_QUEUE_URL: generateMenuAlternativesQueue.queueUrl,
        OPEN_SEARCH_ENDPOINT: 'openSearchEndpoint'
      },
      memorySize: 512,
      timeout: cdk.Duration.seconds(this.sqsTimeout),
      vpc,
      securityGroups: [vpcSecurityGroup]
    });

    this.addCommonLambdaPolicies_(lambdaFunction);

    new events.Rule(this, 'ExecuteScheduleRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(rateMin)),
      targets: [new events_targets.LambdaFunction(lambdaFunction)],
    });

    return lambdaFunction;
  }
}
