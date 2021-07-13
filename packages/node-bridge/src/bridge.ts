/// <reference types="node" />
import { AddressInfo } from 'net';
import {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import {
  Server,
  IncomingHttpHeaders,
  OutgoingHttpHeaders,
  request,
} from 'http';

// Remember that all header names are lower-cased in API Gateway context
// However the local API Gateway emulation does not guarantee that they are
// always lower-cased (https://github.com/aws/aws-sam-cli/issues/3034)
const HEADER_KEY_X_FORWARDED_HOST = 'x-forwarded-host';
const HEADER_KEY_COOKIE = 'cookie';
const HEADER_KEY_HOST = 'host';

export interface NowProxyRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface NowProxyResponse {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: string;
  isBase64Encoded: boolean;
}

interface ServerLike {
  timeout?: number;
  listen: (
    opts: {
      host?: string;
      port?: number;
    },
    callback: (this: Server | null) => void
  ) => Server | void;
}

/**
 * If the `http.Server` handler function throws an error asynchronously,
 * then it ends up being an unhandled rejection which doesn't kill the node
 * process which causes the HTTP request to hang indefinitely. So print the
 * error here and force the process to exit so that the lambda invocation
 * returns an Unhandled error quickly.
 */
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

function findInsensitiveKeyInObject(obj: Record<string, any>, key: string) {
  // Check for exact match first
  if (key in obj) {
    return key;
  }

  // Try to find insensitive key
  const lowerCaseKey = key.toLowerCase();
  for (const indexKey in obj) {
    if (indexKey.toLowerCase() === lowerCaseKey) {
      return indexKey;
    }
  }

  return null;
}

function normalizeAPIGatewayProxyEvent(
  event: APIGatewayProxyEventV2
): NowProxyRequest {
  let bodyBuffer: Buffer | null;
  const {
    requestContext: {
      http: { method },
    },
    rawQueryString,
    headers = {},
    body,
    pathParameters = {},
    cookies,
  } = event;
  // Since we always use a path like
  // `/__NEXT_PAGE_LAMBDA_0/{proxy+}`
  // proxy is always the absolute path without the resource
  // e.g. `/__NEXT_PAGE_LAMBDA_0/test` => proxy: `test`
  const trimmedPath = pathParameters.proxy ? `/${pathParameters.proxy}` : '/';

  // API Gateway cuts the query string from the path
  // https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html
  // TODO: Move to Vercel trusted params in future
  const parameterizedPath = rawQueryString
    ? `${trimmedPath}?${rawQueryString}`
    : trimmedPath;

  // API Gateway 2.0 payload splits cookie header from the rest,
  // so we need to readd them
  if (cookies) {
    headers[HEADER_KEY_COOKIE] = cookies.join('; ');
  }

  // Replace the `host` header with the value of `X-Forwarded-Host` if available
  const forwardedHostHeaderKey = findInsensitiveKeyInObject(
    headers,
    HEADER_KEY_X_FORWARDED_HOST
  );
  if (forwardedHostHeaderKey !== null) {
    headers[HEADER_KEY_HOST] = headers[forwardedHostHeaderKey];
    delete headers[forwardedHostHeaderKey];
  }

  if (body) {
    if (event.isBase64Encoded) {
      bodyBuffer = Buffer.from(body, 'base64');
    } else {
      bodyBuffer = Buffer.from(body);
    }
  } else {
    bodyBuffer = Buffer.alloc(0);
  }

  return {
    method,
    path: parameterizedPath,
    headers,
    body: bodyBuffer,
  };
}
export class Bridge {
  private server: ServerLike | null;
  private listening: Promise<AddressInfo>;
  private resolveListening: (info: AddressInfo) => void;
  private events: { [key: string]: NowProxyRequest } = {};
  private reqIdSeed = 1;
  private shouldStoreEvents = false;

  constructor(server?: ServerLike, shouldStoreEvents = false) {
    this.server = null;
    this.shouldStoreEvents = shouldStoreEvents;
    if (server) {
      this.setServer(server);
    }
    this.launcher = this.launcher.bind(this);

    // This is just to appease TypeScript strict mode, since it doesn't
    // understand that the Promise constructor is synchronous
    this.resolveListening = (_info: AddressInfo) => {}; // eslint-disable-line @typescript-eslint/no-unused-vars

    this.listening = new Promise((resolve) => {
      this.resolveListening = resolve;
    });
  }

  setServer(server: ServerLike) {
    this.server = server;
  }

  listen() {
    const { server, resolveListening } = this;
    if (!server) {
      throw new Error('Server has not been set!');
    }

    if (typeof server.timeout === 'number' && server.timeout > 0) {
      // Disable timeout (usually 2 minutes until Node 13).
      // Instead, user should assign function `maxDuration`.
      server.timeout = 0;
    }

    return server.listen(
      {
        host: '127.0.0.1',
        port: 0,
      },
      function listeningCallback() {
        if (!this || typeof this.address !== 'function') {
          throw new Error(
            'Missing server.address() function on `this` in server.listen()'
          );
        }

        const addr = this.address();

        if (!addr) {
          throw new Error('`server.address()` returned `null`');
        }

        if (typeof addr === 'string') {
          throw new Error(
            `Unexpected string for \`server.address()\`: ${addr}`
          );
        }

        resolveListening(addr);
      }
    );
  }

  async launcher(
    event: APIGatewayProxyEventV2,
    context: Pick<Context, 'callbackWaitsForEmptyEventLoop'>
  ): Promise<APIGatewayProxyStructuredResultV2> {
    context.callbackWaitsForEmptyEventLoop = false;
    const { port } = await this.listening;

    const normalizedEvent = normalizeAPIGatewayProxyEvent(event);
    const { method, path, headers, body } = normalizedEvent;

    if (this.shouldStoreEvents) {
      const reqId = `${this.reqIdSeed++}`;
      this.events[reqId] = normalizedEvent;
      headers['x-now-bridge-request-id'] = reqId;
    }

    // eslint-disable-next-line consistent-return
    return new Promise((resolve, reject) => {
      const opts = { hostname: '127.0.0.1', port, path, method };
      const req = request(opts, (res) => {
        const response = res;
        const respBodyChunks: Buffer[] = [];
        response.on('data', (chunk) => respBodyChunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => {
          const bodyBuffer = Buffer.concat(respBodyChunks);

          const _headers: Record<string, string> = {};
          const cookies: string[] = [];

          // Iterate over all headers and normalize them (to strings) and filter our cookies
          for (const headerKey in response.headers) {
            const headerValue = response.headers[headerKey];

            // 'content-length' is calculated by API Gateway
            if (headerKey === 'content-length') {
              continue;
            }

            // Filter out cookies
            if (headerKey === 'set-cookie' && headerValue) {
              if (typeof headerValue === 'string') {
                cookies.push(headerValue);
              } else {
                cookies.push(...headerValue);
              }

              continue;
            }

            // Transform multi value headers to comma separated headers
            // ['value1', 'value2'] => 'value1,value2'
            // TODO: Seems like headers are already comma separated when they
            //       arrive here (comment this out and run unit tests)
            //       So we should find out if this is the general behavior of Node.js
            if (Array.isArray(headerValue)) {
              _headers[headerKey] = headerValue.join(', ');
              continue;
            }

            if (headerValue) {
              _headers[headerKey] = headerValue as string;
            }
          }

          resolve({
            cookies,
            statusCode: response.statusCode || 200,
            headers: _headers,
            body: bodyBuffer.toString('base64'),
            isBase64Encoded: true,
          });
        });
      });

      req.on('error', (error) => {
        setTimeout(() => {
          // this lets express print the true error of why the connection was closed.
          // it is probably 'Cannot set headers after they are sent to the client'
          reject(error);
        }, 2);
      });

      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) {
          console.error(
            'Skipping HTTP request header %j because value is undefined',
            name
          );
          continue;
        }
        try {
          req.setHeader(name, value);
        } catch (err) {
          console.error(
            'Skipping HTTP request header: %j',
            `${name}: ${value}`
          );
          console.error(err.message);
        }
      }

      if (body) req.write(body);
      req.end();
    });
  }

  consumeEvent(reqId: string) {
    const event = this.events[reqId];
    delete this.events[reqId];
    return event;
  }
}
