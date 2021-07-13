const assert = require('assert');
const { Server } = require('http');
const { Bridge } = require('../src/bridge');
const { parse: parseUrl } = require('url');

test('port binding', async () => {
  const server = new Server();
  const bridge = new Bridge(server);
  bridge.listen();

  // Test port binding
  const info = await bridge.listening;
  expect(info.address).toBe('127.0.0.1');
  expect(typeof info.port).toBe('number');

  server.close();
});

test('[APIGatewayProxyEvent] normalizing', async () => {
  const server = new Server((req, res) => {
    res.setHeader('Set-Cookie', 'abc');
    res.setHeader('x-some-multi-header', ['d', 'e', 'f']);

    res.end(
      JSON.stringify({
        method: req.method,
        path: req.url,
        headers: req.headers,
      })
    );
  });
  const bridge = new Bridge(server);
  bridge.listen();
  const context = {};
  const result = await bridge.launcher(
    {
      headers: { foo: 'bar', multi: 'a,b,c' },
      rawPath: '/__NEXT_PAGE_LAMBDA_0/test/a/b/c/',
      requestContext: {
        http: {
          method: 'GET',
          path: '/__NEXT_PAGE_LAMBDA_0/test/a/b/c/',
        },
      },
      pathParameters: {
        proxy: 'test/a/b/c/',
      },
      body: null,
    },
    context
  );

  expect(result.isBase64Encoded).toBe(true);
  expect(result.statusCode).toBe(200);
  expect(result.isBase64Encoded).toBe(true);
  expect(result.headers['set-cookie']).toBeUndefined();
  expect(result.headers['Set-Cookie']).toBeUndefined();
  expect(result.cookies).toEqual(['abc']);
  expect(result.headers).toEqual(
    expect.objectContaining({
      'x-some-multi-header': 'd, e, f',
    })
  );

  const body = JSON.parse(Buffer.from(result.body, 'base64').toString());
  expect(body.method).toBe('GET');
  expect(body.path).toBe('/test/a/b/c/');
  expect(body.headers.foo).toBe('bar');
  expect(body.headers.multi).toEqual('a,b,c');
  expect(context.callbackWaitsForEmptyEventLoop).toBe(false);

  server.close();
});

test('[APIGatewayProxyEvent] cookie handling', async () => {
  const server = new Server((req, res) => {
    res.setHeader('Set-Cookie', ['server-cookie-1', 'server-cookie-2']);

    res.end(
      JSON.stringify({
        method: req.method,
        path: req.url,
        headers: req.headers,
      })
    );
  });

  const bridge = new Bridge(server);
  bridge.listen();
  const context = {};

  const result = await bridge.launcher(
    {
      cookies: ['cookie-1; cookie-2', 'cookie-3'],
      rawPath: '/__NEXT_PAGE_LAMBDA_0/',
      requestContext: {
        http: {
          method: 'POST',
          path: '/__NEXT_PAGE_LAMBDA_0/',
        },
      },
      pathParameters: {
        proxy: '',
      },
      body: null,
    },
    context
  );

  expect(result.cookies).toEqual(['server-cookie-1', 'server-cookie-2']);

  const body = JSON.parse(Buffer.from(result.body, 'base64').toString());
  expect(body.method).toBe('POST');
  expect(body.path).toBe('/');
  expect(body.headers.cookie).toBe('cookie-1; cookie-2; cookie-3');

  server.close();
});

test('[APIGatewayProxyEvent] Querystring handling', async () => {
  const server = new Server((req, res) => {
    const { query } = parseUrl(req.url, true);

    res.end(
      JSON.stringify({
        method: req.method,
        path: req.url,
        query: query,
        headers: req.headers,
      })
    );
  });

  const bridge = new Bridge(server);
  bridge.listen();
  const context = {};

  const result = await bridge.launcher(
    {
      rawQueryString: 'id=param1&id=param2',
      queryStringParameters: {
        id: 'param1,param2',
      },
      rawPath: '/__NEXT_PAGE_LAMBDA_0/',
      requestContext: {
        http: {
          method: 'GET',
          path: '/__NEXT_PAGE_LAMBDA_0/',
        },
      },
      pathParameters: {
        proxy: '',
      },
      body: null,
    },
    context
  );

  const body = JSON.parse(Buffer.from(result.body, 'base64').toString());
  expect(body.method).toBe('GET');
  expect(body.path).toBe(`/?id=param1&id=param2`);
  expect(body.query).toEqual({
    id: ['param1', 'param2'],
  });

  server.close();
});

test('consumeEvent', async () => {
  const mockListener = jest.fn((req, res) => {
    res.end('hello');
  });

  const server = new Server(mockListener);
  const bridge = new Bridge(server, true);
  bridge.listen();

  const context = { callbackWaitsForEmptyEventLoop: true };
  await bridge.launcher(
    {
      headers: { foo: 'baz' },
      requestContext: {
        http: {
          method: 'POST',
          path: '/nowproxy',
        },
      },
      rawPath: '/nowproxy',
      body: 'body=1',
    },
    context
  );

  const headers = mockListener.mock.calls[0][0].headers;
  const reqId = headers['x-now-bridge-request-id'];

  expect(reqId).toBeTruthy();

  const event = bridge.consumeEvent(reqId);
  expect(event.body.toString()).toBe('body=1');

  // an event can't be consumed multiple times
  // to avoid memory leaks
  expect(bridge.consumeEvent(reqId)).toBeUndefined();

  server.close();
});

test('invalid request headers', async () => {
  const server = new Server((req, res) =>
    res.end(
      JSON.stringify({
        method: req.method,
        path: req.url,
        headers: req.headers,
      })
    )
  );
  const bridge = new Bridge(server);
  bridge.listen();
  const context = { callbackWaitsForEmptyEventLoop: true };
  const result = await bridge.launcher(
    {
      requestContext: {
        http: {
          method: 'GET',
          path: '/nowproxy',
        },
      },
      rawPath: '/nowproxy',
      headers: { foo: 'baz\n', ok: 'true' },
      body: JSON.stringify({
        method: 'GET',
        path: '/nowproxy',
        body: 'body=1',
      }),
      pathParameters: {
        proxy: 'nowproxy',
      },
    },
    context
  );
  expect(result.isBase64Encoded).toBe(true);
  expect(result.statusCode).toBe(200);
  const body = JSON.parse(Buffer.from(result.body, 'base64').toString());
  expect(body.method).toBe('GET');
  expect(body.path).toBe('/nowproxy');
  expect(body.headers.ok).toBe('true');
  assert(!body.headers.foo);
  expect(context.callbackWaitsForEmptyEventLoop).toBe(false);

  server.close();
});

test('[APIGatewayProxyEvent] Replace Host header with X-Forwarded-Host', async () => {
  const server = new Server((req, res) => {
    const { query } = parseUrl(req.url, true);

    res.end(
      JSON.stringify({
        method: req.method,
        path: req.url,
        query: query,
        headers: req.headers,
      })
    );
  });

  const bridge = new Bridge(server);
  bridge.listen();
  const context = {};

  const result = await bridge.launcher(
    {
      rawQueryString: '',
      queryStringParameters: {},
      rawPath: '/__NEXT_PAGE_LAMBDA_0/',
      requestContext: {
        http: {
          method: 'GET',
          path: '/__NEXT_PAGE_LAMBDA_0/',
        },
      },
      headers: { 'x-forwarded-host': 'example.com' },
      pathParameters: {
        proxy: '',
      },
      body: null,
    },
    context
  );

  const body = JSON.parse(Buffer.from(result.body, 'base64').toString());
  expect(body.method).toBe('GET');
  expect(body.headers).toEqual(
    expect.objectContaining({
      host: 'example.com',
    })
  );
  expect(body.headers['x-forwarded-host']).toBeUndefined();

  server.close();
});
