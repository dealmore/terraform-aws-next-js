import { STATUS_CODES } from 'http';
import {
  CloudFrontHeaders,
  CloudFrontResultResponse,
  CloudFrontRequestEvent,
} from 'aws-lambda';

import { ProxyConfig, HTTPHeaders, RouteResult } from './types';
import { Proxy } from './proxy';
import { fetchProxyConfig } from './util/fetch-proxy-config';
import {
  createCustomOriginFromApiGateway,
  createCustomOriginFromUrl,
} from './util/custom-origin';

let proxyConfig: ProxyConfig;
let proxy: Proxy;

function convertToCloudFrontHeaders(
  initialHeaders: CloudFrontHeaders,
  headers: HTTPHeaders
): CloudFrontHeaders {
  const cloudFrontHeaders: CloudFrontHeaders = { ...initialHeaders };
  for (const key in headers) {
    const lowercaseKey = key.toLowerCase();
    cloudFrontHeaders[lowercaseKey] = [{ key, value: headers[key] }];
  }

  return cloudFrontHeaders;
}

/**
 * Checks if a route result issued a redirect
 */
function isRedirect(
  routeResult: RouteResult
): false | CloudFrontResultResponse {
  if (
    routeResult.status &&
    routeResult.status >= 300 &&
    routeResult.status <= 309
  ) {
    if ('Location' in routeResult.headers) {
      let headers: CloudFrontHeaders = {};

      // If the redirect is permanent, add caching it
      if (routeResult.status === 301 || routeResult.status === 308) {
        headers['cache-control'] = [
          {
            key: 'Cache-Control',
            value: 'public,max-age=31536000,immutable',
          },
        ];
      }

      return {
        status: routeResult.status.toString(),
        statusDescription: STATUS_CODES[routeResult.status],
        headers: convertToCloudFrontHeaders(headers, routeResult.headers),
      };
    }
  }

  return false;
}

export async function handler(event: CloudFrontRequestEvent) {
  const { request } = event.Records[0].cf;
  const configEndpoint = request.origin!.s3!.customHeaders[
    'x-env-config-endpoint'
  ][0].value;
  const apiEndpoint = request.origin!.s3!.customHeaders['x-env-api-endpoint'][0]
    .value;
  let headers: Record<string, string> = {};

  try {
    if (!proxyConfig) {
      proxyConfig = await fetchProxyConfig(configEndpoint);
      proxy = new Proxy(
        proxyConfig.routes,
        proxyConfig.lambdaRoutes,
        proxyConfig.staticRoutes
      );
    }
  } catch (err) {
    console.error('Error while initialization:', err);
    return request;
  }

  // Append query string if we have one
  // @see: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html
  const requestPath = `${request.uri}${
    request.querystring !== '' ? `?${request.querystring}` : ''
  }`;

  // Check if we have a prerender route
  // Bypasses proxy
  if (request.uri in proxyConfig.prerenders) {
    // Modify request to be served from Api Gateway
    const customOrigin = createCustomOriginFromApiGateway(
      apiEndpoint,
      `/${proxyConfig.prerenders[request.uri].lambda}`
    );
    request.origin = {
      custom: customOrigin,
    };

    // Modify `Host` header to match the external host
    headers.host = apiEndpoint;
  } else {
    // Handle by proxy
    const proxyResult = proxy.route(requestPath);

    // Check for redirect
    const redirect = isRedirect(proxyResult);
    if (redirect) {
      return redirect;
    }

    // Check if route is served by lambda
    if (proxyResult.target === 'lambda') {
      // Modify request to be served from Api Gateway
      const customOrigin = createCustomOriginFromApiGateway(
        apiEndpoint,
        proxyResult.dest
      );
      request.origin = {
        custom: customOrigin,
      };

      // Add X-Forwarded-Host header which contains the original header
      if (request.headers['host']) {
        headers['X-Forwarded-Host'] = request.headers['host'][0].value;
      }

      // Modify `Host` header to match the external host
      headers.host = apiEndpoint;

      // Append querystring if we have any
      request.querystring = proxyResult.uri_args
        ? proxyResult.uri_args.toString()
        : '';
    } else if (proxyResult.target === 'url') {
      // Modify request to be served from external host
      const [customOrigin, destUrl] = createCustomOriginFromUrl(
        proxyResult.dest
      );
      request.origin = {
        custom: customOrigin,
      };

      // Add X-Forwarded-Host header which contains the original header
      if (request.headers['host']) {
        headers['X-Forwarded-Host'] = request.headers['host'][0].value;
      }

      // Modify `Host` header to match the external host
      headers.host = customOrigin.domainName;

      // Modify URI to match the path
      request.uri = destUrl.pathname;

      // Append querystring if we have any
      request.querystring = proxyResult.uri_args
        ? proxyResult.uri_args.toString()
        : '';
    } else {
      // Route is served by S3 bucket
      const notFound =
        proxyResult.phase === 'error' && proxyResult.status === 404;

      if (!notFound && proxyResult.found) {
        request.uri = proxyResult.dest;
      }

      // Replace the last / with /index when requesting the resource from S3
      request.uri = request.uri.replace(/\/$/, '/index');

      // Send 404 directly to S3 bucket for handling without rewrite
      if (notFound) {
        return request;
      }
    }

    headers = { ...proxyResult.headers, ...headers };
  }

  // Modify headers
  request.headers = convertToCloudFrontHeaders(request.headers, headers);

  if (!request.uri) {
    request.uri = '/';
  }

  return request;
}
