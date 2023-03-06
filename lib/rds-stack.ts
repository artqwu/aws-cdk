import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

// extend the props of the stack by adding the vpc type from the SharedInfraStack
export interface RdsStackProps extends cdk.StackProps {
    vpc: ec2.Vpc;
}

export class RdsStack extends cdk.Stack {
    private vpc: ec2.Vpc;

    constructor(scope: Construct, id: string, props: RdsStackProps) {
        super(scope, id, props);

        const allAll = ec2.Port.allTraffic();
        const tcp3306 = ec2.Port.tcpRange(3306, 3306);

        const dbsg = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
            vpc: props.vpc,
            allowAllOutbound: true,
            description: id + 'Database',
            securityGroupName: id + 'Database',
        });

        dbsg.addIngressRule(dbsg, allAll, 'all from self');
        dbsg.addEgressRule(ec2.Peer.ipv4('0.0.0.0/0'), allAll, 'all out');

        const mysqlConnectionPorts = [
            { port: tcp3306, description: 'tcp3306 Mysql' },
        ];

        const instance = new rds.DatabaseInstance(this, 'Instance', {
            engine: rds.DatabaseInstanceEngine.mysql({
                version: rds.MysqlEngineVersion.VER_5_7_38,
            }),
            backupRetention: cdk.Duration.days(7),
            allocatedStorage: 20,
            securityGroups: [dbsg],
            // optional, defaults to m5.large
            // instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.SMALL),
            credentials: rds.Credentials.fromGeneratedSecret('admin'), // Optional - will default to 'admin' username and generated password
            vpc: props.vpc,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            storageEncrypted: true,
            monitoringInterval: cdk.Duration.seconds(60),
            publiclyAccessible: false,
        });

    }
}