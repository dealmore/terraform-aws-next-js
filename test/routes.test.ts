import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { parse as parseJSON } from 'hjson';
import { ConfigOutput } from 'tf-next/src/types';
import { CloudFrontResultResponse } from 'aws-lambda';
import {
  generateSAM,
  LambdaSAM,
  generateProxySAM,
  ProxySAM,
  normalizeCloudFrontHeaders,
  ConfigLambda,
} from '@dealmore/sammy';
import unzipper, { Entry } from 'unzipper';
import etl from 'etl';

// We use an increased timeout here because in the worst case
// AWS SAM needs to download a docker image before the test can run
const TEST_TIMEOUT = 2 * 60 * 1000;

const pathToFixtures = path.join(__dirname, 'fixtures');
const pathToProxyPackage = path.join(__dirname, '../packages/proxy/dist.zip');

interface ProbeFile {
  probes: {
    path: string;
    mustContain?: string;
    status?: number;
    statusDescription?: string;
    responseHeaders?: Record<string, string>;
    requestHeaders?: Record<string, string>;
    destPath?: string;
  }[];
}

describe('Test proxy config', () => {
  for (const fixture of fs.readdirSync(pathToFixtures)) {
    describe(`Testing fixture: ${fixture}`, () => {
      const pathToFixture = path.join(pathToFixtures, fixture);
      let config: ConfigOutput;
      let probeFile: ProbeFile;
      let lambdaSAM: LambdaSAM;
      let proxySAM: ProxySAM;
      let samEndpoint: string;

      beforeAll(async () => {
        // Get the config
        config = require(path.join(
          pathToFixture,
          '.next-tf/config.json'
        )) as ConfigOutput;

        // Get the probes
        probeFile = parseJSON(
          fs
            .readFileSync(path.join(pathToFixture, 'probes.json'))
            .toString('utf-8')
        ) as ProbeFile;

        // Generate SAM for SSR (Lambda)
        const lambdas: Record<string, ConfigLambda> = {};
        for (const [key, lambda] of Object.entries(config.lambdas)) {
          lambdas[key] = {
            ...lambda,
            route: undefined,
            routes: {
              ApiRoot: `${lambda.route}/`,
              Api: `${lambda.route}/{proxy+}`,
            },
            memorySize: 1024,
          };
        }

        lambdaSAM = await generateSAM({
          lambdas,
          cwd: path.join(pathToFixture, '.next-tf'),
          onData(data) {
            console.log(data.toString());
          },
          onError(data) {
            console.log(data.toString());
          },
        });
        samEndpoint = await lambdaSAM.start();

        // Generate SAM for Proxy (Lambda@Edge)
        const proxyConfig = {
          routes: config.routes,
          staticRoutes: config.staticRoutes,
          lambdaRoutes: Object.values(config.lambdas).map(
            (lambda) => lambda.route
          ),
          prerenders: config.prerenders,
        };

        proxySAM = await generateProxySAM({
          runtime: 'nodejs14.x',
          pathToProxyPackage,
          proxyConfig: JSON.stringify(proxyConfig),
          onData(data) {
            console.log(data.toString());
          },
          onError(data) {
            console.log(data.toString());
          },
        });
        await proxySAM.start();
      }, TEST_TIMEOUT);

      afterAll(async () => {
        // Shutdown SAM
        await lambdaSAM.stop();
        await proxySAM.stop();
      }, TEST_TIMEOUT);

      test(
        'Proxy',
        async () => {
          for (const probe of probeFile.probes) {
            const Request = await proxySAM.sendRequestEvent({
              uri: probe.path,
              headers: probe.requestHeaders,
            });

            if ('origin' in Request) {
              // Request
              if (Request.origin?.custom) {
                if (Request.origin.custom.domainName === 'local-apigw.local') {
                  // Request should be served by lambda (SSR)
                  const basePath = Request.origin.custom.path;
                  const { uri, querystring } = Request;

                  // Merge request headers and custom headers from origin
                  const headers = {
                    ...normalizeCloudFrontHeaders(Request.headers),
                    ...normalizeCloudFrontHeaders(
                      Request.origin.custom.customHeaders
                    ),
                  };
                  const requestPath = `${basePath}${uri}${
                    querystring !== '' ? `?${querystring}` : ''
                  }`;

                  const lambdaResponse = await lambdaSAM
                    .sendApiGwRequest(requestPath, {
                      headers,
                    })
                    .then((res) => {
                      return res.text();
                    });

                  if (probe.mustContain) {
                    expect(lambdaResponse).toContain(probe.mustContain);
                  }
                } else {
                  // Request is an external rewrite
                  if (probe.destPath) {
                    const { custom: customOrigin } = Request.origin;
                    const originRequest = new URL(
                      `${customOrigin.protocol}://${customOrigin.domainName}${
                        Request.uri
                      }${Request.querystring ? `?${Request.querystring}` : ''}`
                    );

                    // Check for custom ports
                    if (customOrigin.port !== 80 && customOrigin.port !== 443) {
                      originRequest.port = customOrigin.port.toString();
                    }

                    expect(originRequest).toEqual(new URL(probe.destPath));
                  }
                }
              } else if (Request.origin?.s3) {
                // Request should be served by static file system (S3)
                // Check static routes
                const { uri } = Request;
                if (config.staticRoutes.find((route) => route === uri)) {
                  const pathToStaticFilesArchive = path.join(
                    pathToFixture,
                    '.next-tf',
                    config.staticFilesArchive
                  );

                  const fileContent = await new Promise<Buffer>(
                    (resolve, reject) => {
                      let found = false;
                      // Remove leading / from the path
                      const filePath = uri.replace(/^\//, '');

                      fs.createReadStream(pathToStaticFilesArchive)
                        .pipe(unzipper.Parse())
                        .pipe(
                          etl.map(async (entry: Entry) => {
                            if (entry.path === filePath) {
                              const content = await entry.buffer();
                              found = true;
                              resolve(content);
                            } else {
                              entry.autodrain();
                            }
                          })
                        )
                        .on('finish', () => {
                          if (!found) {
                            reject(`Could not find static file ${filePath}`);
                          }
                        });
                    }
                  ).then((buffer) => buffer.toString('utf-8'));

                  if (probe.mustContain) {
                    expect(fileContent).toContain(probe.mustContain);
                  }
                } else {
                  fail(
                    `Could not resolve ${probe.path} to an existing lambda! (Resolved to: ${uri})`
                  );
                }
              } else {
                fail(`Path ${probe.path} returned invalid proxy request`);
              }
            } else {
              // Request-Response
              const Response = Request as CloudFrontResultResponse;

              if (probe.status) {
                expect(Response.status).toBe(probe.status.toString());
              }

              for (const header in probe.responseHeaders) {
                const lowerHeader = header.toLowerCase();
                expect(Response.headers![lowerHeader]).toBeDefined();
                expect(Response.headers![lowerHeader]).toContainEqual(
                  expect.objectContaining({
                    value: probe.responseHeaders[header],
                  })
                );
              }

              if (probe.statusDescription) {
                expect(Response.statusDescription).toBe(
                  probe.statusDescription
                );
              }
            }
          }
        },
        TEST_TIMEOUT
      );
    });
  }
});
