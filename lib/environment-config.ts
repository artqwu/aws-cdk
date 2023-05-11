/**
 * Interface for account-based environment configuration in cdk.context.json
 */
export interface IEnvironmentConfig {
    readonly imageTag: string,
    readonly domain: string,
    readonly hostedZoneId: string,
    readonly certArn: string,
    readonly symfonyEnv: string,
}