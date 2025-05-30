import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IAws, IECRClient } from '../aws';
import type { EventEmitter } from '../progress';
import { EventType } from '../progress';

export interface DockerCredentials {
  readonly Username: string;
  readonly Secret: string;
}

export interface DockerCredentialsConfig {
  readonly version: string;
  readonly domainCredentials: Record<string, DockerDomainCredentialSource>;
}

export interface DockerDomainCredentialSource {
  readonly secretsManagerSecretId?: string;
  readonly secretsUsernameField?: string;
  readonly secretsPasswordField?: string;
  readonly ecrRepository?: boolean;
  readonly assumeRoleArn?: string;
}

/** Returns the presumed location of the CDK Docker credentials config file */
export function cdkCredentialsConfigFile(): string {
  return (
    process.env.CDK_DOCKER_CREDS_FILE ??
    path.join(
      (os.userInfo().homedir ?? os.homedir()).trim() || '/',
      '.cdk',
      'cdk-docker-creds.json',
    )
  );
}

let _cdkCredentials: DockerCredentialsConfig | undefined;
/** Loads and parses the CDK Docker credentials configuration, if it exists. */
export function cdkCredentialsConfig(): DockerCredentialsConfig | undefined {
  if (!_cdkCredentials) {
    try {
      _cdkCredentials = JSON.parse(
        fs.readFileSync(cdkCredentialsConfigFile(), { encoding: 'utf-8' }),
      ) as DockerCredentialsConfig;
    } catch {
    }
  }
  return _cdkCredentials;
}

/**
 * Just for testing
 */
export function _clearCdkCredentialsConfigCache() {
  _cdkCredentials = undefined;
}

/** Fetches login credentials from the configured source (e.g., SecretsManager, ECR) */
export async function fetchDockerLoginCredentials(
  aws: IAws,
  config: DockerCredentialsConfig,
  endpoint: string,
) {
  // Paranoid handling to ensure new URL() doesn't throw if the schema is missing
  // For official docker registry, docker will pass https://index.docker.io/v1/
  endpoint = endpoint.includes('://') ? endpoint : `https://${endpoint}`;
  const domain = new URL(endpoint).hostname;

  if (
    !Object.keys(config.domainCredentials).includes(domain) &&
    !Object.keys(config.domainCredentials).includes(endpoint)
  ) {
    throw new Error(`unknown domain ${domain}`);
  }

  let domainConfig = config.domainCredentials[domain] ?? config.domainCredentials[endpoint];

  if (domainConfig.secretsManagerSecretId) {
    const sm = await aws.secretsManagerClient({ assumeRoleArn: domainConfig.assumeRoleArn });
    const secretValue = await sm.getSecretValue({
      SecretId: domainConfig.secretsManagerSecretId,
    });
    if (!secretValue.SecretString) {
      throw new Error(
        `unable to fetch SecretString from secret: ${domainConfig.secretsManagerSecretId}`,
      );
    }

    const secret = JSON.parse(secretValue.SecretString);

    const usernameField = domainConfig.secretsUsernameField ?? 'username';
    const secretField = domainConfig.secretsPasswordField ?? 'secret';
    if (!secret[usernameField] || !secret[secretField]) {
      throw new Error(
        `malformed secret string ("${usernameField}" or "${secretField}" field missing)`,
      );
    }

    return { Username: secret[usernameField], Secret: secret[secretField] };
  } else if (domainConfig.ecrRepository) {
    const ecr = await aws.ecrClient({ assumeRoleArn: domainConfig.assumeRoleArn });
    const ecrAuthData = await obtainEcrCredentials(ecr);

    return { Username: ecrAuthData.username, Secret: ecrAuthData.password };
  } else {
    throw new Error('unknown credential type: no secret ID or ECR repo');
  }
}

export async function obtainEcrCredentials(ecr: IECRClient, eventEmitter?: EventEmitter) {
  if (eventEmitter) {
    eventEmitter(EventType.DEBUG, 'Fetching ECR authorization token');
  }

  const authData = (await ecr.getAuthorizationToken()).authorizationData || [];
  if (authData.length === 0) {
    throw new Error('No authorization data received from ECR');
  }
  const token = Buffer.from(authData[0].authorizationToken!, 'base64').toString('ascii');
  const [username, password] = token.split(':');
  if (!username || !password) {
    throw new Error('unexpected ECR authData format');
  }

  return {
    username,
    password,
    endpoint: authData[0].proxyEndpoint!,
  };
}
