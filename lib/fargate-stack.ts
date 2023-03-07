import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

// extend the props of the stack by adding the vpc type from the SharedInfraStack
export interface FargateStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

export class FargateStack extends cdk.Stack {
  private vpc: ec2.Vpc;

  public readonly cluster: ecs_patterns.ApplicationLoadBalancedFargateService;

  constructor(scope: Construct, id: string, props: FargateStackProps) {
    super(scope, id, props);

    const allAll = ec2.Port.allTraffic();
    const tcp3306 = ec2.Port.tcpRange(3306, 3306);

    const dbsg = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: props.vpc,
      allowAllOutbound: true,
      description: id + 'Database',
      securityGroupName: id + 'Database',
    });

    // dbsg.addIngressRule(dbsg, allAll, 'all from self');
    // dbsg.addEgressRule(ec2.Peer.ipv4('0.0.0.0/0'), allAll, 'all out');


    const rdsInstance = new rds.DatabaseInstance(this, 'Instance', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_5_7_38,
      }),
      backupRetention: cdk.Duration.days(7),
      allocatedStorage: 20,
      // securityGroups: [dbsg],
      // optional, defaults to m5.large
      // instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.SMALL),
      credentials: rds.Credentials.fromGeneratedSecret('admin'), // Optional - will default to 'admin' username and generated password
      vpc: props.vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      storageEncrypted: true,
      monitoringInterval: cdk.Duration.seconds(60),
      publiclyAccessible: false,
    });

    // Create security group for RDS instance
    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'MyRdsSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for my RDS instance',
      allowAllOutbound: true,
    });
    // rdsInstance.connections.allowFrom(rdsSecurityGroup, ec2.Port.tcp(3306), 'Allow access from Fargate task');

    // Create task role with access to RDS instance
    const taskRole = new iam.Role(this, 'EcsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'));
    taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonRDSDataFullAccess'));
    taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadWrite'));
    rdsInstance.grantConnect(taskRole);

    // The code that defines your stack goes here
    const cluster = new ecs.Cluster(this, "WebServiceCluster", {
      vpc: props.vpc
    });

    const repo = ecr.Repository.fromRepositoryName(this, 'tdd-ecr', 'web-service');
    const tag = '0.0.84';
    const image = ecs.ContainerImage.fromEcrRepository(repo, tag);
    const certArn = 'arn:aws:acm:us-east-2:962199888341:certificate/d5f3d620-8561-485b-9478-c0bc787b1b43';
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', certArn);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'MyTaskDefinition', {
      taskRole,
      cpu: 4096, // Default is 256
      memoryLimitMiB: 16384,
    });

    const logDriver = ecs.LogDriver.awsLogs({
      streamPrefix: 'web-service'
    });

    const container = taskDefinition.addContainer('MyContainer', {
      cpu: 4096, // Default is 256
      image: image,
      memoryLimitMiB: 16384,
      portMappings: [{ containerPort: 443 }],
      environment: {
        RDS_HOSTNAME: rdsInstance.dbInstanceEndpointAddress,
        RDS_PORT: rdsInstance.dbInstanceEndpointPort,
        RDS_DB_NAME: 'mydatabase',
        RDS_USERNAME: 'myuser',
        RDS_PASSWORD: 'mypassword',
      },
      logging: logDriver
    });

    // Create a load-balanced Fargate service and make it public
    const loadBalancedFargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "MyFargateService", {
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

    rdsInstance.connections.allowFrom(loadBalancedFargateService.service, tcp3306, 'allow from ecs service');
    this.cluster = loadBalancedFargateService;

    // example resource
    // const queue = new sqs.Queue(this, 'SrcQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
