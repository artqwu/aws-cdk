# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `cdk deploy`      deploy this stack to your default AWS account/region
* `cdk diff`        compare deployed stack with current state
* `cdk synth`       emits the synthesized CloudFormation template

## Fixed infrastructure
- OU
- IAM user group 'web-services' with user 'web-service' with polcies
- -
- Route 53
- Certificate Manager: certificate
- ECR
- Secrets Manager: RDS symfony user password, auth credentials

## Platform

- VpcStack: VPC, gateway endpoints
- RdsStack: RDS, bastion host
- WebServiceStack: ECS Fargate cluster, ALB, ECS service, SQS, Lambda functions, EFS, Opensearch


# Build and deploy platform
## 1. build/tag/push all images to AWS OU with version tag
### Windows command prompt

`SYMFONY_PROJECT_DIR> ./scripts/aws/deploy.bat {AWS profile} {tag}`

### Ex:

`[dd_backend_symfony]> ./scripts/aws/deploy.bat devuser 0.0.88`

## 2. deploy stacks to AWS OU (Linux/bash)

`[aws_cdk]$ AWS_KEY_ID={symfony_iam_key_id} \`

`AWS_KEY_SECRET={symfony_iam_key_secret} \`

`cdk deploy [--all | VpcStack | RdsStack | WebServiceStack] --profile devuser`

# Bastion Host connect options
## 1. open shell to bastion host using SSM in Windows

`[\]> aws ssm start-session --target {EC2 instance ID} --profile devuser`

## 2. connect to remote host using SSM in Windows (Kibana/Opensearch)

`[\]> aws ssm start-session --target {EC2 instance ID} --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host="{Opensearch host}",portNumber="443",localPortNumber="9200" --profile devuser
`

Kibana: open browser to https://localhost:9200/_plugin/kibana/app/kibana

## 3. EC2 Instance Connect for terminal or remote host (MySQL)

`[/.ssh]$ aws ec2-instance-connect send-ssh-public-key --instance-id {EC2 instance ID} --availability-zone us-east-2a --instance-os-user ec2-user --ssh-public-key file://dev-bastion-key.pub --profile devuser
`

open shell session or MySQL Workbench proxy to EC2 instance host (user: ec2-user)


# Using ECS exec to connect to an ECS task

## 1. enable ECS exec on ECS service

`[\]> aws ecs update-service --cluster {ECS cluster name} --service {service name} --enable-execute-command --force-new-deployment --profile devuser`

## 2. confirm exec command enabled
`[\]> aws ecs describe-tasks --cluster [cluster name] --tasks [task arn] --profile devuser`


## 3. open bash shell to ECS task using ECS exec

`[\]> aws ecs execute-command --cluster {ECS cluster name} --task {task arn} --container {container name} --interactive --command "/bin/bash" --profile devuser`
`

ex:

`
[\]> aws ecs execute-command --cluster WebServiceStack-WebServiceCluster7DA3FC56-iUugBhnPkXWz --task arn:aws:ecs:us-east-2:962199888341:task/WebServiceStack-WebServiceCluster7DA3FC56-iUugBhnPkXWz/e1f2e0527f114780b6f924540cafe872 --container WebContainer --interactive --command "/bin/bash" --profile devuser
`