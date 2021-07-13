import { createServer, Server } from 'http';
import { CloudFrontRequestEvent, CloudFrontRequest } from 'aws-lambda';
import getPort from 'get-port';

import { ProxyConfig } from '../types';

// Max runtime of the lambda
const TIMEOUT = 30000;

class ConfigServer {
  public proxyConfig?: ProxyConfig;
  private server?: Server;

  async start() {
    const port = await getPort();
    this.server = createServer((_req, res) => {
      res.end(JSON.stringify(this.proxyConfig));
    });

    await new Promise<void>((resolve) => this.server!.listen(port, resolve));

    return `http://localhost:${port}`;
  }

  stop() {
    if (!this.server) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }
}

describe('[proxy] Handler', () => {
  let handler: any;
  let configServer: ConfigServer;
  let configEndpoint: string;

  beforeEach(async () => {
    // Since the handler has it's own state we need to isolate it between test runs to prevent
    // using a cached proxyConfig
    jest.isolateModules(() => {
      handler = require('../handler').handler;
    });

    configServer = new ConfigServer();
    configEndpoint = await configServer.start();
  });

  afterEach(async () => {
    await configServer.stop();
  });

  test(
    'External redirect [HTTP]',
    async () => {
      const proxyConfig: ProxyConfig = {
        lambdaRoutes: [],
        prerenders: {},
        staticRoutes: [],
        routes: [
          {
            src: '^\\/docs(?:\\/([^\\/]+?))$',
            dest: 'http://example.com/docs/$1',
            check: true,
          },
        ],
      };
      const requestPath = '/docs/hello-world';

      // Prepare configServer
      configServer.proxyConfig = proxyConfig;

      // Origin Request
      // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html#example-origin-request
      const event: CloudFrontRequestEvent = {
        Records: [
          {
            cf: {
              config: {
                distributionDomainName: 'd111111abcdef8.cloudfront.net',
                distributionId: 'EDFDVBD6EXAMPLE',
                eventType: 'origin-request',
                requestId:
                  '4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==',
              },
              request: {
                clientIp: '203.0.113.178',
                headers: {
                  'x-forwarded-for': [
                    {
                      key: 'X-Forwarded-For',
                      value: '203.0.113.178',
                    },
                  ],
                  'user-agent': [
                    {
                      key: 'User-Agent',
                      value: 'Amazon CloudFront',
                    },
                  ],
                  via: [
                    {
                      key: 'Via',
                      value:
                        '2.0 2afae0d44e2540f472c0635ab62c232b.cloudfront.net (CloudFront)',
                    },
                  ],
                  host: [
                    {
                      key: 'Host',
                      value: 'example.org',
                    },
                  ],
                  'cache-control': [
                    {
                      key: 'Cache-Control',
                      value: 'no-cache, cf-no-cache',
                    },
                  ],
                },
                method: 'GET',
                origin: {
                  s3: {
                    customHeaders: {
                      'x-env-config-endpoint': [
                        {
                          key: 'x-env-config-endpoint',
                          value: configEndpoint,
                        },
                      ],
                      'x-env-api-endpoint': [
                        {
                          key: 'x-env-api-endpoint',
                          value: 'example.localhost',
                        },
                      ],
                    },
                    region: 'us-east-1',
                    authMethod: 'origin-access-identity',
                    domainName: 's3.localhost',
                    path: '',
                  },
                },
                querystring: '',
                uri: requestPath,
              },
            },
          },
        ],
      };

      const result = (await handler(event)) as CloudFrontRequest;

      expect(result.origin?.custom).toEqual(
        expect.objectContaining({
          domainName: 'example.com',
          path: '',
          port: 80,
          protocol: 'http',
        })
      );
      expect(result.uri).toBe('/docs/hello-world');
      expect(result.headers.host).toEqual(
        expect.arrayContaining([
          {
            key: 'host',
            value: 'example.com',
          },
        ])
      );
    },
    TIMEOUT
  );

  test(
    'External redirect [HTTPS]',
    async () => {
      const proxyConfig: ProxyConfig = {
        lambdaRoutes: [],
        prerenders: {},
        staticRoutes: [],
        routes: [
          {
            src: '^\\/docs(?:\\/([^\\/]+?))$',
            dest: 'https://example.com/docs/$1',
            check: true,
          },
        ],
      };
      const requestPath = '/docs/hello-world';

      // Prepare configServer
      configServer.proxyConfig = proxyConfig;

      // Origin Request
      // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html#example-origin-request
      const event: CloudFrontRequestEvent = {
        Records: [
          {
            cf: {
              config: {
                distributionDomainName: 'd111111abcdef8.cloudfront.net',
                distributionId: 'EDFDVBD6EXAMPLE',
                eventType: 'origin-request',
                requestId:
                  '4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==',
              },
              request: {
                clientIp: '203.0.113.178',
                headers: {
                  'x-forwarded-for': [
                    {
                      key: 'X-Forwarded-For',
                      value: '203.0.113.178',
                    },
                  ],
                  'user-agent': [
                    {
                      key: 'User-Agent',
                      value: 'Amazon CloudFront',
                    },
                  ],
                  via: [
                    {
                      key: 'Via',
                      value:
                        '2.0 2afae0d44e2540f472c0635ab62c232b.cloudfront.net (CloudFront)',
                    },
                  ],
                  host: [
                    {
                      key: 'Host',
                      value: 'example.org',
                    },
                  ],
                  'cache-control': [
                    {
                      key: 'Cache-Control',
                      value: 'no-cache, cf-no-cache',
                    },
                  ],
                },
                method: 'GET',
                origin: {
                  s3: {
                    customHeaders: {
                      'x-env-config-endpoint': [
                        {
                          key: 'x-env-config-endpoint',
                          value: configEndpoint,
                        },
                      ],
                      'x-env-api-endpoint': [
                        {
                          key: 'x-env-api-endpoint',
                          value: 'example.localhost',
                        },
                      ],
                    },
                    region: 'us-east-1',
                    authMethod: 'origin-access-identity',
                    domainName: 's3.localhost',
                    path: '',
                  },
                },
                querystring: '',
                uri: requestPath,
              },
            },
          },
        ],
      };

      const result = (await handler(event)) as CloudFrontRequest;

      expect(result.origin?.custom).toEqual(
        expect.objectContaining({
          domainName: 'example.com',
          path: '',
          port: 443,
          protocol: 'https',
        })
      );
      expect(result.uri).toBe('/docs/hello-world');
      expect(result.headers.host).toEqual(
        expect.arrayContaining([
          {
            key: 'host',
            value: 'example.com',
          },
        ])
      );
    },
    TIMEOUT
  );

  test(
    'External redirect [Custom Port]',
    async () => {
      const proxyConfig: ProxyConfig = {
        lambdaRoutes: [],
        prerenders: {},
        staticRoutes: [],
        routes: [
          {
            src: '^\\/docs(?:\\/([^\\/]+?))$',
            dest: 'https://example.com:666/docs/$1',
            check: true,
          },
        ],
      };
      const requestPath = '/docs/hello-world';

      // Prepare configServer
      configServer.proxyConfig = proxyConfig;

      // Origin Request
      // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html#example-origin-request
      const event: CloudFrontRequestEvent = {
        Records: [
          {
            cf: {
              config: {
                distributionDomainName: 'd111111abcdef8.cloudfront.net',
                distributionId: 'EDFDVBD6EXAMPLE',
                eventType: 'origin-request',
                requestId:
                  '4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==',
              },
              request: {
                clientIp: '203.0.113.178',
                headers: {
                  'x-forwarded-for': [
                    {
                      key: 'X-Forwarded-For',
                      value: '203.0.113.178',
                    },
                  ],
                  'user-agent': [
                    {
                      key: 'User-Agent',
                      value: 'Amazon CloudFront',
                    },
                  ],
                  via: [
                    {
                      key: 'Via',
                      value:
                        '2.0 2afae0d44e2540f472c0635ab62c232b.cloudfront.net (CloudFront)',
                    },
                  ],
                  host: [
                    {
                      key: 'Host',
                      value: 'example.org',
                    },
                  ],
                  'cache-control': [
                    {
                      key: 'Cache-Control',
                      value: 'no-cache, cf-no-cache',
                    },
                  ],
                },
                method: 'GET',
                origin: {
                  s3: {
                    customHeaders: {
                      'x-env-config-endpoint': [
                        {
                          key: 'x-env-config-endpoint',
                          value: configEndpoint,
                        },
                      ],
                      'x-env-api-endpoint': [
                        {
                          key: 'x-env-api-endpoint',
                          value: 'example.localhost',
                        },
                      ],
                    },
                    region: 'us-east-1',
                    authMethod: 'origin-access-identity',
                    domainName: 's3.localhost',
                    path: '',
                  },
                },
                querystring: '',
                uri: requestPath,
              },
            },
          },
        ],
      };

      const result = (await handler(event)) as CloudFrontRequest;

      expect(result.origin?.custom).toEqual(
        expect.objectContaining({
          domainName: 'example.com',
          path: '',
          port: 666,
          protocol: 'https',
        })
      );
      expect(result.uri).toBe('/docs/hello-world');
      expect(result.headers.host).toEqual(
        expect.arrayContaining([
          {
            key: 'host',
            value: 'example.com',
          },
        ])
      );
    },
    TIMEOUT
  );

  test(
    'External redirect [Subdomain]',
    async () => {
      const proxyConfig: ProxyConfig = {
        lambdaRoutes: [],
        prerenders: {},
        staticRoutes: [],
        routes: [
          {
            src: '^\\/docs(?:\\/([^\\/]+?))$',
            dest: 'https://sub.example.com/docs/$1',
            check: true,
          },
        ],
      };
      const requestPath = '/docs/hello-world';

      // Prepare configServer
      configServer.proxyConfig = proxyConfig;

      // Origin Request
      // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html#example-origin-request
      const event: CloudFrontRequestEvent = {
        Records: [
          {
            cf: {
              config: {
                distributionDomainName: 'd111111abcdef8.cloudfront.net',
                distributionId: 'EDFDVBD6EXAMPLE',
                eventType: 'origin-request',
                requestId:
                  '4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==',
              },
              request: {
                clientIp: '203.0.113.178',
                headers: {
                  'x-forwarded-for': [
                    {
                      key: 'X-Forwarded-For',
                      value: '203.0.113.178',
                    },
                  ],
                  'user-agent': [
                    {
                      key: 'User-Agent',
                      value: 'Amazon CloudFront',
                    },
                  ],
                  via: [
                    {
                      key: 'Via',
                      value:
                        '2.0 2afae0d44e2540f472c0635ab62c232b.cloudfront.net (CloudFront)',
                    },
                  ],
                  host: [
                    {
                      key: 'Host',
                      value: 'example.org',
                    },
                  ],
                  'cache-control': [
                    {
                      key: 'Cache-Control',
                      value: 'no-cache, cf-no-cache',
                    },
                  ],
                },
                method: 'GET',
                origin: {
                  s3: {
                    customHeaders: {
                      'x-env-config-endpoint': [
                        {
                          key: 'x-env-config-endpoint',
                          value: configEndpoint,
                        },
                      ],
                      'x-env-api-endpoint': [
                        {
                          key: 'x-env-api-endpoint',
                          value: 'example.localhost',
                        },
                      ],
                    },
                    region: 'us-east-1',
                    authMethod: 'origin-access-identity',
                    domainName: 's3.localhost',
                    path: '',
                  },
                },
                querystring: '',
                uri: requestPath,
              },
            },
          },
        ],
      };

      const result = (await handler(event)) as CloudFrontRequest;

      expect(result.origin?.custom).toEqual(
        expect.objectContaining({
          domainName: 'sub.example.com',
          path: '',
          port: 443,
          protocol: 'https',
        })
      );
      expect(result.uri).toBe('/docs/hello-world');
      expect(result.headers.host).toEqual(
        expect.arrayContaining([
          {
            key: 'host',
            value: 'sub.example.com',
          },
        ])
      );
    },
    TIMEOUT
  );

  test(
    'i18n default locale rewrite',
    async () => {
      const proxyConfig: ProxyConfig = {
        lambdaRoutes: [],
        prerenders: {},
        staticRoutes: [],
        routes: [
          {
            src: '^/(?!(?:_next/.*|en|fr\\-FR|nl)(?:/.*|$))(.*)$',
            dest: '$wildcard/$1',
            continue: true,
          },
          {
            src: '/',
            locale: {
              redirect: {
                en: '/',
                'fr-FR': '/fr-FR',
                nl: '/nl',
              },
              cookie: 'NEXT_LOCALE',
            },
            continue: true,
          },
          {
            src: '^/$',
            dest: '/en',
            continue: true,
          },
        ],
      };
      const requestPath = '/';

      // Prepare configServer
      configServer.proxyConfig = proxyConfig;

      // Origin Request
      // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html#example-origin-request
      const event: CloudFrontRequestEvent = {
        Records: [
          {
            cf: {
              config: {
                distributionDomainName: 'd111111abcdef8.cloudfront.net',
                distributionId: 'EDFDVBD6EXAMPLE',
                eventType: 'origin-request',
                requestId:
                  '4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==',
              },
              request: {
                clientIp: '203.0.113.178',
                headers: {
                  'x-forwarded-for': [
                    {
                      key: 'X-Forwarded-For',
                      value: '203.0.113.178',
                    },
                  ],
                  'user-agent': [
                    {
                      key: 'User-Agent',
                      value: 'Amazon CloudFront',
                    },
                  ],
                  via: [
                    {
                      key: 'Via',
                      value:
                        '2.0 2afae0d44e2540f472c0635ab62c232b.cloudfront.net (CloudFront)',
                    },
                  ],
                  host: [
                    {
                      key: 'Host',
                      value: 'example.org',
                    },
                  ],
                  'cache-control': [
                    {
                      key: 'Cache-Control',
                      value: 'no-cache, cf-no-cache',
                    },
                  ],
                },
                method: 'GET',
                origin: {
                  s3: {
                    customHeaders: {
                      'x-env-config-endpoint': [
                        {
                          key: 'x-env-config-endpoint',
                          value: configEndpoint,
                        },
                      ],
                      'x-env-api-endpoint': [
                        {
                          key: 'x-env-api-endpoint',
                          value: 'example.localhost',
                        },
                      ],
                    },
                    region: 'us-east-1',
                    authMethod: 'origin-access-identity',
                    domainName: 's3.localhost',
                    path: '',
                  },
                },
                querystring: '',
                uri: requestPath,
              },
            },
          },
        ],
      };

      const result = (await handler(event)) as CloudFrontRequest;

      expect(result.origin?.s3).toEqual(
        expect.objectContaining({
          domainName: 's3.localhost',
          path: '',
        })
      );
      expect(result.uri).toBe('/en');
    },
    TIMEOUT
  );

  test(
    'Correctly request /index object from S3 when requesting /',
    async () => {
      const proxyConfig: ProxyConfig = {
        staticRoutes: ['/404', '/500', '/index'],
        lambdaRoutes: [],
        routes: [
          {
            src: '^(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))\\/$',
            headers: {
              Location: '/$1',
            },
            status: 308,
            continue: true,
          },
          {
            src: '/404',
            status: 404,
            continue: true,
          },
          {
            handle: 'filesystem',
          },
          {
            handle: 'resource',
          },
          {
            src: '/.*',
            status: 404,
          },
          {
            handle: 'miss',
          },
          {
            handle: 'rewrite',
          },
          {
            handle: 'hit',
          },
          {
            handle: 'error',
          },
          {
            src: '/.*',
            dest: '/404',
            status: 404,
          },
        ],
        prerenders: {},
      };

      const requestPath = '/';

      // Prepare configServer
      configServer.proxyConfig = proxyConfig;

      // Origin Request
      // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html#example-origin-request
      const event: CloudFrontRequestEvent = {
        Records: [
          {
            cf: {
              config: {
                distributionDomainName: 'd111111abcdef8.cloudfront.net',
                distributionId: 'EDFDVBD6EXAMPLE',
                eventType: 'origin-request',
                requestId:
                  '4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==',
              },
              request: {
                clientIp: '203.0.113.178',
                headers: {
                  'x-forwarded-for': [
                    {
                      key: 'X-Forwarded-For',
                      value: '203.0.113.178',
                    },
                  ],
                  'user-agent': [
                    {
                      key: 'User-Agent',
                      value: 'Amazon CloudFront',
                    },
                  ],
                  via: [
                    {
                      key: 'Via',
                      value:
                        '2.0 2afae0d44e2540f472c0635ab62c232b.cloudfront.net (CloudFront)',
                    },
                  ],
                  host: [
                    {
                      key: 'Host',
                      value: 'example.org',
                    },
                  ],
                  'cache-control': [
                    {
                      key: 'Cache-Control',
                      value: 'no-cache, cf-no-cache',
                    },
                  ],
                },
                method: 'GET',
                origin: {
                  s3: {
                    customHeaders: {
                      'x-env-config-endpoint': [
                        {
                          key: 'x-env-config-endpoint',
                          value: configEndpoint,
                        },
                      ],
                      'x-env-api-endpoint': [
                        {
                          key: 'x-env-api-endpoint',
                          value: 'example.localhost',
                        },
                      ],
                    },
                    region: 'us-east-1',
                    authMethod: 'origin-access-identity',
                    domainName: 's3.localhost',
                    path: '',
                  },
                },
                querystring: '',
                uri: requestPath,
              },
            },
          },
        ],
      };

      const result = (await handler(event)) as CloudFrontRequest;

      expect(result.origin?.s3).toEqual(
        expect.objectContaining({
          domainName: 's3.localhost',
          path: '',
        })
      );
      expect(result.uri).toBe('/index');
    },
    TIMEOUT
  );

  test(
    'Add x-forwarded-host header to API-Gateway requests',
    async () => {
      const hostHeader = 'example.org';
      const proxyConfig: ProxyConfig = {
        lambdaRoutes: ['/__NEXT_API_LAMBDA_0'],
        prerenders: {},
        staticRoutes: [],
        routes: [
          {
            src: '^(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))\\/$',
            headers: {
              Location: '/$1',
            },
            status: 308,
            continue: true,
          },
          {
            src: '/404',
            status: 404,
            continue: true,
          },
          {
            handle: 'filesystem',
          },
          {
            src: '^/api/test/?$',
            dest: '/__NEXT_API_LAMBDA_0',
            headers: {
              'x-nextjs-page': '/api/test',
            },
            check: true,
          },
          {
            handle: 'resource',
          },
          {
            src: '/.*',
            status: 404,
          },
          {
            handle: 'miss',
          },
          {
            handle: 'rewrite',
          },
          {
            src: '^/api/test/?$',
            dest: '/__NEXT_API_LAMBDA_0',
            headers: {
              'x-nextjs-page': '/api/test',
            },
            check: true,
          },
          {
            handle: 'hit',
          },
          {
            handle: 'error',
          },
          {
            src: '/.*',
            dest: '/404',
            status: 404,
          },
        ],
      };
      const requestPath = '/api/test';

      // Prepare configServer
      configServer.proxyConfig = proxyConfig;

      // Origin Request
      // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html#example-origin-request
      const event: CloudFrontRequestEvent = {
        Records: [
          {
            cf: {
              config: {
                distributionDomainName: 'd111111abcdef8.cloudfront.net',
                distributionId: 'EDFDVBD6EXAMPLE',
                eventType: 'origin-request',
                requestId:
                  '4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==',
              },
              request: {
                clientIp: '203.0.113.178',
                headers: {
                  'x-forwarded-for': [
                    {
                      key: 'X-Forwarded-For',
                      value: '203.0.113.178',
                    },
                  ],
                  'user-agent': [
                    {
                      key: 'User-Agent',
                      value: 'Amazon CloudFront',
                    },
                  ],
                  via: [
                    {
                      key: 'Via',
                      value:
                        '2.0 2afae0d44e2540f472c0635ab62c232b.cloudfront.net (CloudFront)',
                    },
                  ],
                  host: [
                    {
                      key: 'Host',
                      value: hostHeader,
                    },
                  ],
                  'cache-control': [
                    {
                      key: 'Cache-Control',
                      value: 'no-cache, cf-no-cache',
                    },
                  ],
                },
                method: 'GET',
                origin: {
                  s3: {
                    customHeaders: {
                      'x-env-config-endpoint': [
                        {
                          key: 'x-env-config-endpoint',
                          value: configEndpoint,
                        },
                      ],
                      'x-env-api-endpoint': [
                        {
                          key: 'x-env-api-endpoint',
                          value: 'api-gateway.local',
                        },
                      ],
                    },
                    region: 'us-east-1',
                    authMethod: 'origin-access-identity',
                    domainName: 's3.localhost',
                    path: '',
                  },
                },
                querystring: '',
                uri: requestPath,
              },
            },
          },
        ],
      };

      const result = (await handler(event)) as CloudFrontRequest;

      expect(result.origin?.custom).toEqual(
        expect.objectContaining({
          domainName: 'api-gateway.local',
          path: '/__NEXT_API_LAMBDA_0',
        })
      );
      expect(result.headers).toEqual(
        expect.objectContaining({
          'x-nextjs-page': [
            {
              key: 'x-nextjs-page',
              value: '/api/test',
            },
          ],
          'x-forwarded-host': [
            {
              key: 'X-Forwarded-Host',
              value: hostHeader,
            },
          ],
        })
      );
    },
    TIMEOUT
  );
});
