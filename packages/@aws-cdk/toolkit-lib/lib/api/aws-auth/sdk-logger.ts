import { inspect, format } from 'util';
import { replacerBufferWithInfo } from '../../util';
import type { IoHelper } from '../io/private';
import { IO } from '../io/private';

export interface ISdkLogger {
  trace?: (...content: any[]) => void;
  debug: (...content: any[]) => void;
  info: (...content: any[]) => void;
  warn: (...content: any[]) => void;
  error: (...content: any[]) => void;
}

export class IoHostSdkLogger implements ISdkLogger {
  private readonly ioHelper: IoHelper;

  public constructor(ioHelper: IoHelper) {
    this.ioHelper = ioHelper;
  }

  private notify(level: 'info' | 'warn' | 'error', ...content: any[]) {
    void this.ioHelper.notify(IO.CDK_SDK_I0100.msg(format('[SDK %s] %s', level, formatSdkLoggerContent(content)), {
      sdkLevel: level,
      content,
    }));
  }

  public trace(..._content: any[]) {
    // This is too much detail for our logs
    // this.notify('trace', ...content);
  }

  public debug(..._content: any[]) {
    // This is too much detail for our logs
    // this.notify('debug', ...content);
  }

  /**
   * Info is called mostly (exclusively?) for successful API calls
   *
   * Payload:
   *
   * (Note the input contains entire CFN templates, for example)
   *
   * ```
   * {
   *   clientName: 'S3Client',
   *   commandName: 'GetBucketLocationCommand',
   *   input: {
   *     Bucket: '.....',
   *     ExpectedBucketOwner: undefined
   *   },
   *   output: { LocationConstraint: 'eu-central-1' },
   *   metadata: {
   *     httpStatusCode: 200,
   *     requestId: '....',
   *     extendedRequestId: '...',
   *     cfId: undefined,
   *     attempts: 1,
   *     totalRetryDelay: 0
   *   }
   * }
   * ```
   */
  public info(...content: any[]) {
    this.notify('info', ...content);
  }

  public warn(...content: any[]) {
    this.notify('warn', ...content);
  }

  /**
   * Error is called mostly (exclusively?) for failing API calls
   *
   * Payload (input would be the entire API call arguments).
   *
   * ```
   * {
   *   clientName: 'STSClient',
   *   commandName: 'GetCallerIdentityCommand',
   *   input: {},
   *   error: AggregateError [ECONNREFUSED]:
   *       at internalConnectMultiple (node:net:1121:18)
   *       at afterConnectMultiple (node:net:1688:7) {
   *     code: 'ECONNREFUSED',
   *     '$metadata': { attempts: 3, totalRetryDelay: 600 },
   *     [errors]: [ [Error], [Error] ]
   *   },
   *   metadata: { attempts: 3, totalRetryDelay: 600 }
   * }
   * ```
   */
  public error(...content: any[]) {
    this.notify('error', ...content);
  }
}

/**
 * This can be anything.
 *
 * For debug, it seems to be mostly strings.
 * For info, it seems to be objects.
 *
 * Stringify and join without separator.
 */
export function formatSdkLoggerContent(content: any[]) {
  if (content.length === 1) {
    const apiFmt = formatApiCall(content[0]);
    if (apiFmt) {
      return apiFmt;
    }
  }
  return content.map((x) => typeof x === 'string' ? x : inspect(x)).join('');
}

function formatApiCall(content: any): string | undefined {
  if (!isSdkApiCallSuccess(content) && !isSdkApiCallError(content)) {
    return undefined;
  }

  const service = content.clientName.replace(/Client$/, '');
  const api = content.commandName.replace(/Command$/, '');

  const parts = [];
  if ((content.metadata?.attempts ?? 0) > 1) {
    parts.push(`[${content.metadata?.attempts} attempts, ${content.metadata?.totalRetryDelay}ms retry]`);
  }

  parts.push(`${service}.${api}(${JSON.stringify(content.input, replacerBufferWithInfo)})`);

  if (isSdkApiCallSuccess(content)) {
    parts.push('-> OK');
  } else {
    parts.push(`-> ${content.error}`);
  }

  return parts.join(' ');
}

interface SdkApiCallBase {
  clientName: string;
  commandName: string;
  input: Record<string, unknown>;
  metadata?: {
    httpStatusCode?: number;
    requestId?: string;
    extendedRequestId?: string;
    cfId?: string;
    attempts?: number;
    totalRetryDelay?: number;
  };
}

type SdkApiCallSuccess = SdkApiCallBase & { output: Record<string, unknown> };
type SdkApiCallError = SdkApiCallBase & { error: Error };

function isSdkApiCallSuccess(x: any): x is SdkApiCallSuccess {
  return x && typeof x === 'object' && x.commandName && x.output;
}

function isSdkApiCallError(x: any): x is SdkApiCallError {
  return x && typeof x === 'object' && x.commandName && x.error;
}
