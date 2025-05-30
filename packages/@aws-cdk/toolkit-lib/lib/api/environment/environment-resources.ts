import type { Environment } from '@aws-cdk/cx-api';
import { ToolkitError } from '../../toolkit/toolkit-error';
import { formatErrorMessage } from '../../util';
import type { SDK } from '../aws-auth/private';
import { type IoHelper } from '../io/private';
import { Notices } from '../notices';
import { type EcrRepositoryInfo, ToolkitInfo } from '../toolkit-info';

/**
 * Registry class for `EnvironmentResources`.
 *
 * The state management of this class is a bit non-standard. We want to cache
 * data related to toolkit stacks and SSM parameters, but we are not in charge
 * of ensuring caching of SDKs. Since `EnvironmentResources` needs an SDK to
 * function, we treat it as an ephemeral class, and store the actual cached data
 * in `EnvironmentResourcesRegistry`.
 */
export class EnvironmentResourcesRegistry {
  private readonly cache = new Map<string, EnvironmentCache>();

  constructor(private readonly toolkitStackName?: string) {
  }

  public for(resolvedEnvironment: Environment, sdk: SDK, ioHelper: IoHelper) {
    const key = `${resolvedEnvironment.account}:${resolvedEnvironment.region}`;
    let envCache = this.cache.get(key);
    if (!envCache) {
      envCache = emptyCache();
      this.cache.set(key, envCache);
    }
    return new EnvironmentResources(resolvedEnvironment, sdk, ioHelper, envCache, this.toolkitStackName);
  }
}

/**
 * Interface with the account and region we're deploying into
 *
 * Manages lookups for bootstrapped resources, falling back to the legacy "CDK Toolkit"
 * original bootstrap stack if necessary.
 *
 * The state management of this class is a bit non-standard. We want to cache
 * data related to toolkit stacks and SSM parameters, but we are not in charge
 * of ensuring caching of SDKs. Since `EnvironmentResources` needs an SDK to
 * function, we treat it as an ephemeral class, and store the actual cached data
 * in `EnvironmentResourcesRegistry`.
 */
export class EnvironmentResources {
  constructor(
    public readonly environment: Environment,
    private readonly sdk: SDK,
    private readonly ioHelper: IoHelper,
    private readonly cache: EnvironmentCache,
    private readonly toolkitStackName?: string,
  ) {
  }

  /**
   * Look up the toolkit for a given environment, using a given SDK
   */
  public async lookupToolkit() {
    if (!this.cache.toolkitInfo) {
      this.cache.toolkitInfo = await ToolkitInfo.lookup(this.environment, this.sdk, this.ioHelper, this.toolkitStackName);
    }
    return this.cache.toolkitInfo;
  }

  /**
   * Validate that the bootstrap stack version matches or exceeds the expected version
   *
   * Use the SSM parameter name to read the version number if given, otherwise use the version
   * discovered on the bootstrap stack.
   *
   * Pass in the SSM parameter name so we can cache the lookups an don't need to do the same
   * lookup again and again for every artifact.
   */
  public async validateVersion(expectedVersion: number | undefined, ssmParameterName: string | undefined) {
    if (expectedVersion === undefined) {
      // No requirement
      return;
    }
    const defExpectedVersion = expectedVersion;

    if (ssmParameterName !== undefined) {
      try {
        doValidate(await this.versionFromSsmParameter(ssmParameterName), this.environment);
        return;
      } catch (e: any) {
        if (e.name !== 'AccessDeniedException') {
          throw e;
        }

        // This is a fallback! The bootstrap template that goes along with this change introduces
        // a new 'ssm:GetParameter' permission, but when run using the previous bootstrap template we
        // won't have the permissions yet to read the version, so we won't be able to show the
        // message telling the user they need to update! When we see an AccessDeniedException, fall
        // back to the version we read from Stack Outputs; but ONLY if the version we discovered via
        // outputs is legitimately an old version. If it's newer than that, something else must be broken,
        // so let it fail as it would if we didn't have this fallback.
        const bootstrapStack = await this.lookupToolkit();
        if (bootstrapStack.found && bootstrapStack.version < BOOTSTRAP_TEMPLATE_VERSION_INTRODUCING_GETPARAMETER) {
          await this.ioHelper.defaults.warn(
            `Could not read SSM parameter ${ssmParameterName}: ${formatErrorMessage(e)}, falling back to version from ${bootstrapStack}`,
          );
          doValidate(bootstrapStack.version, this.environment);
          return;
        }

        throw new ToolkitError(
          `This CDK deployment requires bootstrap stack version '${expectedVersion}', but during the confirmation via SSM parameter ${ssmParameterName} the following error occurred: ${e}`,
        );
      }
    }

    // No SSM parameter
    const bootstrapStack = await this.lookupToolkit();
    doValidate(bootstrapStack.version, this.environment);

    function doValidate(version: number, environment: Environment) {
      const notices = Notices.get();
      if (notices) {
        // if `Notices` hasn't been initialized there is probably a good
        // reason for it. handle gracefully.
        notices.addBootstrappedEnvironment({ bootstrapStackVersion: version, environment });
      }
      if (defExpectedVersion > version) {
        throw new ToolkitError(
          `This CDK deployment requires bootstrap stack version '${expectedVersion}', found '${version}'. Please run 'cdk bootstrap'.`,
        );
      }
    }
  }

  /**
   * Read a version from an SSM parameter, cached
   */
  public async versionFromSsmParameter(parameterName: string): Promise<number> {
    const existing = this.cache.ssmParameters.get(parameterName);
    if (existing !== undefined) {
      return existing;
    }

    const ssm = this.sdk.ssm();

    try {
      const result = await ssm.getParameter({ Name: parameterName });

      const asNumber = parseInt(`${result.Parameter?.Value}`, 10);
      if (isNaN(asNumber)) {
        throw new ToolkitError(`SSM parameter ${parameterName} not a number: ${result.Parameter?.Value}`);
      }

      this.cache.ssmParameters.set(parameterName, asNumber);
      return asNumber;
    } catch (e: any) {
      if (e.name === 'ParameterNotFound') {
        throw new ToolkitError(
          `SSM parameter ${parameterName} not found. Has the environment been bootstrapped? Please run \'cdk bootstrap\' (see https://docs.aws.amazon.com/cdk/latest/guide/bootstrapping.html)`,
        );
      }
      throw e;
    }
  }

  public async prepareEcrRepository(repositoryName: string): Promise<EcrRepositoryInfo> {
    if (!this.sdk) {
      throw new ToolkitError('ToolkitInfo needs to have been initialized with an sdk to call prepareEcrRepository');
    }
    const ecr = this.sdk.ecr();

    // check if repo already exists
    try {
      await this.ioHelper.defaults.debug(`${repositoryName}: checking if ECR repository already exists`);
      const describeResponse = await ecr.describeRepositories({
        repositoryNames: [repositoryName],
      });
      const existingRepositoryUri = describeResponse.repositories![0]?.repositoryUri;
      if (existingRepositoryUri) {
        return { repositoryUri: existingRepositoryUri };
      }
    } catch (e: any) {
      if (e.name !== 'RepositoryNotFoundException') {
        throw e;
      }
    }

    // create the repo (tag it so it will be easier to garbage collect in the future)
    await this.ioHelper.defaults.debug(`${repositoryName}: creating ECR repository`);
    const assetTag = { Key: 'awscdk:asset', Value: 'true' };
    const response = await ecr.createRepository({
      repositoryName,
      tags: [assetTag],
    });
    const repositoryUri = response.repository?.repositoryUri;
    if (!repositoryUri) {
      throw new ToolkitError(`CreateRepository did not return a repository URI for ${repositoryUri}`);
    }

    // configure image scanning on push (helps in identifying software vulnerabilities, no additional charge)
    await this.ioHelper.defaults.debug(`${repositoryName}: enable image scanning`);
    await ecr.putImageScanningConfiguration({
      repositoryName,
      imageScanningConfiguration: { scanOnPush: true },
    });

    return { repositoryUri };
  }
}

export class NoBootstrapStackEnvironmentResources extends EnvironmentResources {
  constructor(environment: Environment, sdk: SDK, ioHelper: IoHelper) {
    super(environment, sdk, ioHelper, emptyCache());
  }

  /**
   * Look up the toolkit for a given environment, using a given SDK
   */
  public async lookupToolkit(): Promise<ToolkitInfo> {
    throw new ToolkitError(
      'Trying to perform an operation that requires a bootstrap stack; you should not see this error, this is a bug in the CDK CLI.',
    );
  }
}

/**
 * Data that is cached on a per-environment level
 *
 * This cache may be shared between different instances of the `EnvironmentResources` class.
 */
interface EnvironmentCache {
  readonly ssmParameters: Map<string, number>;
  toolkitInfo?: ToolkitInfo;
}

function emptyCache(): EnvironmentCache {
  return {
    ssmParameters: new Map(),
    toolkitInfo: undefined,
  };
}

/**
 * The bootstrap template version that introduced ssm:GetParameter
 */
const BOOTSTRAP_TEMPLATE_VERSION_INTRODUCING_GETPARAMETER = 5;
