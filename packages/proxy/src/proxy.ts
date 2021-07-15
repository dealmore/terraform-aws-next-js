import { URL, URLSearchParams } from 'url';
import { Route, isHandler, HandleValue } from '@vercel/routing-utils';

import isURL from './util/is-url';
import { RouteResult, HTTPHeaders } from './types';

// Since we have no replacement for url.parse, thanks Node.js
// https://github.com/nodejs/node/issues/12682
const baseUrl = 'http://n';

function parseUrl(url: string) {
  const _url = new URL(url, baseUrl);
  return {
    pathname: _url.pathname,
    searchParams: _url.searchParams,
  };
}

/**
 * Appends URLSearchParams from param 2 to param 1.
 * Basically Object.assign for URLSearchParams
 * @param param1
 * @param param2
 */
function appendURLSearchParams(
  param1: URLSearchParams,
  param2: URLSearchParams
) {
  for (const [key, value] of param2.entries()) {
    param1.append(key, value);
  }
  return param1;
}

/**
 *
 * @param str
 * @param match
 * @param keys
 */
function resolveRouteParameters(
  str: string,
  match: string[],
  keys: string[]
): string {
  return str.replace(/\$([1-9a-zA-Z]+)/g, (_, param) => {
    let matchIndex: number = keys.indexOf(param);
    if (matchIndex === -1) {
      // It's a number match, not a named capture
      matchIndex = parseInt(param, 10);
    } else {
      // For named captures, add one to the `keys` index to
      // match up with the RegExp group matches
      matchIndex++;
    }
    return match[matchIndex] || '';
  });
}

export class Proxy {
  routes: Route[];
  lambdaRoutes: Set<string>;
  staticRoutes: Set<string>;

  constructor(routes: Route[], lambdaRoutes: string[], staticRoutes: string[]) {
    this.routes = routes;
    this.lambdaRoutes = new Set<string>(lambdaRoutes);
    this.staticRoutes = new Set<string>(staticRoutes);
  }

  _checkFileSystem = (path: string) => {
    return this.staticRoutes.has(path);
  };

  route(reqUrl: string) {
    const parsedUrl = parseUrl(reqUrl);
    let { searchParams, pathname: reqPathname = '/' } = parsedUrl;
    let result: RouteResult | undefined;
    let status: number | undefined;
    let isContinue = false;
    let phase: HandleValue | undefined;
    let combinedHeaders: HTTPHeaders = {};
    let target: undefined | 'filesystem' | 'lambda';

    for (let routeIndex = 0; routeIndex < this.routes.length; routeIndex++) {
      /**
       * This is how the routing basically works:
       * (For reference see: https://vercel.com/docs/configuration#routes)
       *
       * 1. Checks if the route is an exact match to a route in the
       *    S3 filesystem (e.g. /test.html -> s3://test.html)
       *    --> true: returns found in filesystem
       * 2.
       *
       */

      const routeConfig = this.routes[routeIndex];

      //////////////////////////////////////////////////////////////////////////
      // Phase 1: Check for handler
      if (isHandler(routeConfig)) {
        phase = routeConfig.handle;

        // Check if the path is a static file that should be served from the
        // filesystem
        if (routeConfig.handle === 'filesystem') {
          // Remove tailing `/` for filesystem check
          const filePath = reqPathname.replace(/\/+$/, '');

          // Check if the route matches a route from the filesystem
          if (this._checkFileSystem(filePath)) {
            result = {
              found: true,
              target: 'filesystem',
              dest: filePath,
              headers: combinedHeaders,
              continue: false,
              isDestUrl: false,
              status,
            };
            break;
          }
        }

        continue;
      }

      // Skip resource phase entirely because we don't support it
      if (phase === 'resource') {
        continue;
      }

      // Special case to allow redirect to kick in when a continue route was touched before
      if (phase === 'error' && isContinue) {
        break;
      }

      //////////////////////////////////////////////////////////////////////////
      // Phase 2: Check for source
      const { src, headers } = routeConfig;
      // Note: Routes are case-insensitive
      // TODO: Performance: Cache matcher results
      const matcher = new RegExp(src, 'i');
      const match = matcher.exec(reqPathname);

      if (match !== null) {
        const keys = Object.keys(match.groups ?? {});
        isContinue = false;
        // The path that should be sent to the target system (lambda or filesystem)
        let destPath: string = reqPathname;

        if (routeConfig.status) {
          status = routeConfig.status;
        }

        if (routeConfig.dest) {
          // Rewrite dynamic routes
          // e.g. /posts/1234 -> /posts/[id]?id=1234
          destPath = resolveRouteParameters(routeConfig.dest, match, keys);
        }

        if (headers) {
          for (const originalKey in headers) {
            const originalValue = headers[originalKey];
            const value = resolveRouteParameters(originalValue, match, keys);
            combinedHeaders[originalKey] = value;
          }
        }

        if (routeConfig.continue) {
          reqPathname = destPath;
          isContinue = true;
        }

        // Check for external rewrite
        const isDestUrl = isURL(destPath);
        if (isDestUrl) {
          result = {
            found: true,
            dest: destPath,
            continue: isContinue,
            userDest: false,
            isDestUrl,
            status: status,
            uri_args: searchParams,
            matched_route: routeConfig,
            matched_route_idx: routeIndex,
            phase,
            headers: combinedHeaders,
            target: 'url',
          };

          if (isContinue) {
            continue;
          }

          break;
        }

        if (routeConfig.check && phase !== 'hit') {
          if (this.lambdaRoutes.has(destPath)) {
            target = 'lambda';
          } else {
            // When it is not a lambda route we cut the url_args
            // for the next iteration
            const nextUrl = parseUrl(destPath);
            reqPathname = nextUrl.pathname!;

            // Check if we have a static route
            // Convert to filePath first, since routes with tailing `/` are
            // stored as `/index` in filesystem
            const filePath = reqPathname.replace(/\/$/, '/index');
            if (!this.staticRoutes.has(filePath)) {
              appendURLSearchParams(searchParams, nextUrl.searchParams);
              continue;
            }
          }
        }

        if (!destPath.startsWith('/')) {
          destPath = `/${destPath}`;
        }

        const destParsed = parseUrl(destPath);
        appendURLSearchParams(searchParams, destParsed.searchParams);
        result = {
          found: true,
          dest: destParsed.pathname || '/',
          continue: isContinue,
          userDest: Boolean(routeConfig.dest),
          isDestUrl,
          status: status,
          uri_args: searchParams,
          matched_route: routeConfig,
          matched_route_idx: routeIndex,
          phase,
          headers: combinedHeaders,
          target,
        };

        if (isContinue) {
          continue;
        }

        break;
      }
    }

    if (!result) {
      result = {
        found: false,
        dest: reqPathname,
        continue: isContinue,
        status,
        isDestUrl: false,
        uri_args: searchParams,
        phase,
        headers: combinedHeaders,
      };
    }

    return result;
  }
}
