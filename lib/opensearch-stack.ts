import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as os from 'aws-cdk-lib/aws-opensearchservice';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export interface OpenSearchStackProps extends cdk.StackProps {
    vpc: ec2.Vpc;
    identity: iam.IGrantable;
}

export class OpenSearchStack extends cdk.Stack {
    public readonly endpoint: string;

    constructor(scope: Construct, id: string, props: OpenSearchStackProps) {
        super(scope, id, props);

        const domainProps: os.DomainProps = {
            version: os.EngineVersion.OPENSEARCH_2_3,
            useUnsignedBasicAuth: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            vpc: props.vpc,
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
        domain.grantRead(props.identity);
        domain.grantWrite(props.identity);

        this.endpoint = domain.domainEndpoint;
    };

}
