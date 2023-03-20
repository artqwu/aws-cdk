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
- users
- Route 53
- Certificate Manager: certificate
- ECR

## Platform

- VpcWithALBAndECS: VPC, ALB, ECS Fargate cluster


# Build and deploy platform
## 1. build/tag/push all images to AWS OU with version tag
### Windows command prompt

`SYMFONY_PROJECT_DIR> ./scripts/aws/deploy.bat {AWS profile} {tag}`

### Ex:

`[dd_backend_symfony]> ./scripts/aws/deploy.bat devuser 0.0.88`

## 2. deploy stacks to AWS OU (Linux/bash)

`[aws_cdk]$ AWS_KEY_ID={symfony_iam_key_id} \`
`AWS_KEY_SECRET={symfony_iam_key_isecret} \`
`cdk deploy [--all | WebServiceStack] --profile devuser`