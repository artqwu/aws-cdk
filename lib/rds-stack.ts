import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export interface RdsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  // cluster: ecs_patterns.ApplicationLoadBalancedFargateService;
  // ecsTaskRole: iam.Role;
  // menuGenerateConsumer: lambda.DockerImageFunction;
  // menuGenerateAlternativesConsumer: lambda.DockerImageFunction;
  // menuScheduler: lambda.DockerImageFunction;
  // scheduleExecutor: lambda.DockerImageFunction;
}

export class RdsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RdsStackProps) {
    super(scope, id, props);

    const defaultSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'DefaultSecurityGroup', props.vpc.vpcDefaultSecurityGroup);

    const rdsInstance = this.createRdsInstance_(props.vpc, defaultSecurityGroup);
    this.createBastionHost_(rdsInstance, props.vpc, defaultSecurityGroup);

    // configure network access: VPC default security group
    // const defaultSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'DefaultSecurityGroup', props.vpc.vpcDefaultSecurityGroup);
    // rdsInstance.connections.addSecurityGroup(defaultSecurityGroup);

    // rdsInstance.grantConnect(props.cluster.taskDefinition.taskRole);
    // rdsInstance.connections.allowFrom(props.cluster.service, tcp3306, 'allow from ecs service');
    // rdsInstance.connections.allowFrom(props.menuGenerateConsumer, tcp3306, 'allow from menu-generate lambda');
    // rdsInstance.connections.allowFrom(props.menuGenerateAlternativesConsumer, tcp3306, 'allow from menu-generate-alternatives lambda');
    // rdsInstance.connections.allowFrom(props.menuScheduler, tcp3306, 'allow from schedule-menu lambda');
    // rdsInstance.connections.allowFrom(props.scheduleExecutor, tcp3306, 'allow from execute-schedule lambda');
  }

  createRdsInstance_(vpc: ec2.Vpc, defaultSecurityGroup: ec2.ISecurityGroup): rds.DatabaseInstance {
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
      securityGroups: [defaultSecurityGroup],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      storageEncrypted: true,
      monitoringInterval: cdk.Duration.seconds(60),
      publiclyAccessible: false,
    });
  }

  createBastionHost_(rdsInstance: rds.DatabaseInstance, vpc: ec2.Vpc, defaultSecurityGroup: ec2.ISecurityGroup): ec2.BastionHostLinux {
    const host = new ec2.BastionHostLinux(this, 'BastionHost', {
      vpc,
      securityGroup: defaultSecurityGroup,
      subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
    });
    // host.allowSshAccessFrom(ec2.Peer.ipv4('24.147.56.174/32'));
    host.allowSshAccessFrom(ec2.Peer.ipv4('0.0.0.0/0'));
    host.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    host.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonElasticFileSystemClientReadWriteAccess'));
    host.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonOpenSearchServiceFullAccess'));

    return host;
  }
}
