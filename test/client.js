'use strict';

const _ = require('lodash');
const assert = require('chai').assert;
const nock = require('nock');
const sinon = require('sinon');

const HttpTransport = require('..');
const Transport = require('../lib/transport/transport');
const toJson = require('../lib/plugins/asJson');
const setContextProperty = require('../lib/plugins/setContextProperty');
const log = require('../lib/plugins/logger');
const packageInfo = require('../package');

const sandbox = sinon.sandbox.create();

const url = 'http://www.example.com/';
const host = 'http://www.example.com';
const api = nock(host);
const path = '/';

const simpleResponseBody = 'Illegitimi non carborundum';
const requestBody = {
  foo: 'bar'
};
const responseBody = requestBody;

function toUpperCase() {
  return (ctx, next) => {
    return next().then(() => {
      ctx.res.body = ctx.res.body.toUpperCase();
    });
  };
}

function assertFailure(promise, message) {
  return promise
    .then(() => assert.ok(false, 'Promise should have failed'))
    .catch((e) => {
      assert.ok(e);
      if (message) {
        assert.equal(e.message, message);
      }
    });
}

function nockRetries(retry, opts) {
  const httpMethod = _.get(opts, 'httpMethod') || 'get';
  const successCode = _.get(opts, 'successCode') || 200;

  nock.cleanAll();
  api[httpMethod](path).times(retry).reply(500);
  api[httpMethod](path).reply(successCode);
}

function nockTimeouts(number, opts) {
  const httpMethod = _.get(opts, 'httpMethod') || 'get';
  const successCode = _.get(opts, 'successCode') || 200;

  nock.cleanAll();
  api[httpMethod](path).times(number).socketDelay(10000).reply(200);
  api[httpMethod](path).reply(successCode);
}

function toError() {
  return (ctx, next) => {
    return next().then(() => {
      if (ctx.res.statusCode >= 400) {
        const err = new Error('something bad happend.');
        err.statusCode = ctx.res.statusCode;
        err.headers = ctx.res.headers;
        throw err;
      }
    });
  };
}

describe('HttpTransport', () => {
  beforeEach(() => {
    nock.disableNetConnect();
    nock.cleanAll();
    api.get(path).reply(200, simpleResponseBody).defaultReplyHeaders({
      'Content-Type': 'text/html'
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('.get', () => {
    it('returns a response', () => {
      return HttpTransport.createClient()
        .get(url)
        .asResponse()
        .then((res) => {
          assert.equal(res.body, simpleResponseBody);
        });
    });

    it('sets a default User-agent for every request', () => {
      nock.cleanAll();

      const HeaderValue = `${packageInfo.name}/${packageInfo.version}`;
      nock(host, {
          reqheaders: {
            'User-Agent': HeaderValue
          }
        })
        .get(path)
        .times(2)
        .reply(200, responseBody);

      const client = HttpTransport.createClient();
      const pending1 = client
        .get(url)
        .asResponse();

      const pending2 = client
        .get(url)
        .asResponse();

      return Promise.all([pending1, pending2]);
    });

    it('overrides the default User-agent for every request', () => {
      nock.cleanAll();

      nock(host, {
          reqheaders: {
            'User-Agent': 'some-new-user-agent'
          }
        })
        .get(path)
        .times(2)
        .reply(200, responseBody);

      const client = HttpTransport.createBuilder()
        .userAgent('some-new-user-agent')
        .createClient();

      const pending1 = client
        .get(url)
        .asResponse();

      const pending2 = client
        .get(url)
        .asResponse();

      return Promise.all([pending1, pending2]);
    });
  });

  describe('default', () => {
    it('sets default retry values in the context', () => {
      const transport = new Transport();
      sandbox.stub(transport, 'execute').returns(Promise.resolve());

      const client = HttpTransport.createBuilder(transport)
        .retries(50)
        .retryDelay(2000)
        .createClient();

      return client.get(url)
        .asResponse()
        .then(() => {
          const ctx = transport.execute.getCall(0).args[0];
          assert.equal(ctx.retries, 50);
          assert.equal(ctx.retryDelay, 2000);
        });
    });
  });

  describe('.retries', () => {
    it('retries a given number of times for failed requests', () => {
      nockRetries(2);

      const client = HttpTransport.createBuilder()
        .use(toError())
        .createClient();

      return client.get(url)
        .retry(2)
        .asResponse()
        .catch(assert.ifError)
        .then((res) => {
          assert.equal(res.statusCode, 200);
        });
    });

    it('retries a given number of times for requests that timed out', () => {
      nockTimeouts(2);

      const client = HttpTransport.createBuilder()
        .use(toError())
        .createClient();

      return client.get(url)
        .timeout(2000)
        .retry(2)
        .asResponse()
        .catch(assert.ifError)
        .then((res) => {
          assert.equal(res.statusCode, 200);
        });
    });

    it('waits a minimum of 100ms between retries by default', () => {
      nockRetries(1);
      const startTime = Date.now();

      const client = HttpTransport.createBuilder()
        .use(toError())
        .createClient();

      return client.get(url)
        .retry(2)
        .asResponse()
        .catch(assert.ifError)
        .then((res) => {
          const timeTaken = Date.now() - startTime;
          assert(timeTaken > 100);
          assert.equal(res.statusCode, 200);
        });
    });

    it('disables retryDelay if retries if set to zero', () => {
      nock.cleanAll();
      api.get(path).reply(500);

      const client = HttpTransport.createBuilder()
        .use(toError())
        .createClient();

      return client.get(url)
        .retry(0)
        .retryDelay(10000)
        .asResponse()
        .then(() => assert.ok(false, 'Promise should have failed'))
        .catch((e) => {
          assert.equal(e.message, 'something bad happend.');
        });
    });

    it('overrides the minimum wait time between retries', () => {
      nockRetries(1);
      const retryDelay = 200;
      const startTime = Date.now();

      const client = HttpTransport.createBuilder()
        .use(toError())
        .createClient();

      return client.get(url)
        .retry(1)
        .retryDelay(retryDelay)
        .asResponse()
        .catch(assert.ifError)
        .then((res) => {
          const timeTaken = Date.now() - startTime;
          assert(timeTaken > retryDelay);
          assert.equal(res.statusCode, 200);
        });
    });

    it('tracks retry attempts', () => {
      nockRetries(2);

      const client = HttpTransport.createClient();

      return client.get(url)
        .use(toError())
        .retry(2)
        .asResponse()
        .catch(assert.ifError)
        .then((res) => {
          const retries = res.retries;
          assert.equal(retries.length, 2);
          assert.equal(retries[0].statusCode, 500);
          assert.match(retries[0].reason, /something bad/);
        });
    });

    it('does not retry 4XX errors', () => {
      nock.cleanAll();
      api.get(path).once().reply(400);

      const client = HttpTransport.createBuilder()
        .use(toError())
        .createClient();

      return client.get(url)
        .retry(1)
        .asResponse()
        .then(() => {
          assert.fail();
        })
        .catch((err) => {
          assert.equal(err.statusCode, 400);
        });
    });
  });

  describe('.post', () => {
    it('makes a POST request', () => {
      api.post(path, requestBody).reply(201, responseBody);

      HttpTransport.createClient()
        .post(url, requestBody)
        .asBody()
        .then((body) => {
          assert.deepEqual(body, responseBody);
        })
        .catch(assert.ifError);
    });

    it('returns an error when the API returns a 5XX status code', () => {
      api.post(path, requestBody).reply(500);

      const client = HttpTransport.createClient();
      const response = client
        .post(url, requestBody)
        .asResponse();

      return assertFailure(response);
    });
  });

  describe('.put', () => {
    it('makes a PUT request with a JSON body', () => {
      api.put(path, requestBody).reply(201, responseBody);

      const client = HttpTransport.createClient();
      client
        .put(url, requestBody)
        .asBody()
        .then((body) => {
          assert.deepEqual(body, responseBody);
        });
    });

    it('returns an error when the API returns a 5XX status code', () => {
      api.put(path, requestBody).reply(500);

      const client = HttpTransport.createClient();
      const response = client
        .put(url, requestBody)
        .asResponse();

      return assertFailure(response);
    });
  });

  describe('.delete', () => {
    it('makes a DELETE request', () => {
      api.delete(path).reply(204);
      return HttpTransport.createClient().delete(url);
    });

    it('returns an error when the API returns a 5XX status code', () => {
      api.delete(path, requestBody).reply(500);

      const client = HttpTransport.createClient();
      const response = client
        .delete(url, requestBody)
        .asResponse();

      return assertFailure(response);
    });
  });

  describe('.patch', () => {
    it('makes a PATCH request', () => {
      api.patch(path).reply(204);
      return HttpTransport.createClient().patch(url);
    });

    it('returns an error when the API returns a 5XX status code', () => {
      api.patch(path, requestBody).reply(500);

      const client = HttpTransport.createClient();
      const response = client
        .patch(url, requestBody)
        .asResponse();

      return assertFailure(response);
    });
  });

  describe('.head', () => {
    it('makes a HEAD request', () => {
      api.head(path).reply(200);

      return HttpTransport.createClient()
        .head(url)
        .asResponse((res) => {
          assert.strictEqual(res.statusCode, 200);
          assert.strictEqual(res.body, undefined);
        });
    });

    it('returns an error when the API returns a 5XX status code', () => {
      api.head(path, requestBody).reply(500);

      const client = HttpTransport.createClient();
      const response = client
        .head(url, requestBody)
        .asResponse();

      return assertFailure(response);
    });
  });

  describe('.headers', () => {
    it('sends a custom headers', () => {
      nock.cleanAll();

      const HeaderValue = `${packageInfo.name}/${packageInfo.version}`;
      nock(host, {
          reqheaders: {
            'User-Agent': HeaderValue,
            foo: 'bar'
          }
        })
        .get(path)
        .reply(200, responseBody);

      const response = HttpTransport.createClient()
        .get(url)
        .headers({
          'User-Agent': HeaderValue,
          foo: 'bar'
        })
        .asResponse();

      return response
        .catch(assert.ifError)
        .then((res) => {
          assert.equal(res.statusCode, 200);
        });
    });

    it('ignores an empty header object', () => {
      return HttpTransport.createClient()
        .headers({})
        .get(url)
        .asResponse()
        .then((res) => {
          assert.equal(res.body, simpleResponseBody);
        });
    });
  });

  describe('query strings', () => {
    it('supports adding a query string', () => {
      api.get('/?a=1').reply(200, simpleResponseBody);

      const client = HttpTransport.createClient();
      return client
        .get(url)
        .query('a', 1)
        .asBody()
        .then((body) => {
          assert.equal(body, simpleResponseBody);
        });
    });

    it('supports multiple query strings', () => {
      nock.cleanAll();
      api.get('/?a=1&b=2&c=3').reply(200, simpleResponseBody);

      const client = HttpTransport.createClient();
      return client
        .get(url)
        .query({
          'a': 1,
          'b': 2,
          'c': 3
        })
        .asBody()
        .then((body) => {
          assert.equal(body, simpleResponseBody);
        });
    });

    it('ignores empty query objects', () => {
      return HttpTransport.createClient()
        .query({})
        .get(url)
        .asResponse()
        .then((res) => {
          assert.equal(res.body, simpleResponseBody);
        });
    });
  });

  describe('timeout', () => {
    it('sets the a timeout', () => {
      nock.cleanAll();
      api.get('/')
        .socketDelay(1000)
        .reply(200, simpleResponseBody);

      const client = HttpTransport.createClient();
      const response = client
        .get(url)
        .timeout(20)
        .asBody();

      return assertFailure(response, 'Request failed for GET http://www.example.com/: ESOCKETTIMEDOUT');
    });
  });

  describe('plugins', () => {
    it('supports a per request plugin', () => {
      nock.cleanAll();
      api.get(path).times(2).reply(200, simpleResponseBody);

      const client = HttpTransport.createClient();

      const upperCaseResponse = client
        .use(toUpperCase())
        .get(url)
        .asBody();

      const lowerCaseResponse = client
        .get(url)
        .asBody();

      return Promise.all([upperCaseResponse, lowerCaseResponse])
        .then((results) => {
          assert.equal(results[0], simpleResponseBody.toUpperCase());
          assert.equal(results[1], simpleResponseBody);
        });
    });

    it('executes global and per request plugins', () => {
      nock.cleanAll();
      api.get(path).reply(200, simpleResponseBody);

      function appendTagGlobally() {
        return (ctx, next) => {
          return next()
            .then(() => {
              ctx.res.body = 'global ' + ctx.res.body;
            });
        };
      }

      function appendTagPerRequestTag() {
        return (ctx, next) => {

          return next()
            .then(() => {
              ctx.res.body = 'request';
            });
        };
      }

      const client = HttpTransport.createBuilder()
        .use(appendTagGlobally())
        .createClient();

      return client
        .use(appendTagPerRequestTag())
        .get(url)
        .asBody()
        .then((body) => {
          assert.equal(body, 'global request');
        });
    });

    it('throws if a global plugin is not a function', () => {
      assert.throws(() => {
        HttpTransport.createBuilder()
          .use('bad plugin');
      }, TypeError, 'Plugin is not a function');
    });

    it('throws if a per request plugin is not a function', () => {
      assert.throws(() => {
        const client = HttpTransport.createClient();
        client
          .use('bad plugin')
          .get(url);
      }, TypeError, 'Plugin is not a function');
    });

    describe('setContextProperty', () => {
      it('sets an option in the context', () => {
        nock.cleanAll();
        api.get(path).reply(200, responseBody);

        const client = HttpTransport.createBuilder()
          .use(toJson())
          .createClient();

        return client
          .use(setContextProperty({
            time: false
          }, 'opts'))
          .get(url)
          .asResponse()
          .then((res) => {
            assert.isUndefined(res.elapsedTime);
          });
      });

      it('sets an explict key on the context', () => {
        nock.cleanAll();
        api
          .get(path)
          .socketDelay(1000)
          .reply(200, responseBody);

        const client = HttpTransport.createBuilder()
          .use(toJson())
          .createClient();

        const response = client
          .use(setContextProperty(20, 'req._timeout'))
          .get(url)
          .asResponse();

        return assertFailure(response, 'Request failed for GET http://www.example.com/: ESOCKETTIMEDOUT');
      });
    });

    describe('toJson', () => {
      it('returns body of a JSON response', () => {
        nock.cleanAll();
        api.defaultReplyHeaders({
            'Content-Type': 'application/json'
          })
          .get(path)
          .reply(200, responseBody);

        const client = HttpTransport.createBuilder()
          .use(toJson())
          .createClient();

        return client
          .get(url)
          .asBody()
          .then((body) => {
            assert.equal(body.foo, 'bar');
          });
      });
    });

    describe('logging', () => {

      it('logs each request at info level when a logger is passed in', () => {
        api.get(path).reply(200);

        const stubbedLogger = {
          info: sandbox.stub(),
          warn: sandbox.stub()
        };

        const client = HttpTransport.createBuilder()
          .use(log(stubbedLogger))
          .createClient();

        client.get(url)
          .asBody()
          .catch(assert.ifError)
          .then(() => {
            const message = stubbedLogger.info.getCall(0).args[0];
            assert.match(message, /GET http:\/\/www.example.com\/ 200 \d+ ms/);
          });
      });

      it('uses default logger', () => {
        sandbox.stub(console, 'info');

        const client = HttpTransport.createBuilder()
          .use(log())
          .createClient();

        return client.get(url)
          .asBody()
          .catch(assert.ifError)
          .then(() => {
            /*eslint no-console: ["error", { allow: ["info"] }] */
            const message = console.info.getCall(0).args[0];
            assert.match(message, /GET http:\/\/www.example.com\/ 200 \d+ ms/);
          });
      });

      it('doesnt log responseTime when undefined', () => {
        sandbox.stub(console, 'info');
        const client = HttpTransport.createBuilder()
          .use(log())
          .createClient();

        return client
          .use(setContextProperty({
            time: false
          }, 'opts'))
          .get(url)
          .asBody()
          .catch(assert.ifError)
          .then(() => {
            /*eslint no-console: ["error", { allow: ["info"] }] */
            const message = console.info.getCall(0).args[0];
            assert.match(message, /GET http:\/\/www.example.com\/ 200$/);
          });
      });

      it('logs retry attempts as warnings when they return a critical error', () => {
        sandbox.stub(console, 'info');
        sandbox.stub(console, 'warn');
        nockRetries(2);

        const client = HttpTransport.createBuilder()
          .use(toError())
          .use(log())
          .createClient();

        return client
          .retry(2)
          .get(url)
          .asBody()
          .catch(assert.ifError)
          .then(() => {
            /*eslint no-console: ["error", { allow: ["info", "warn"] }] */
            sinon.assert.calledOnce(console.warn);
            const intial = console.info.getCall(0).args[0];
            const attempt1 = console.warn.getCall(0).args[0];
            assert.match(intial, /GET http:\/\/www.example.com\/ 500 \d+ ms/);
            assert.match(attempt1, /Attempt 1 GET http:\/\/www.example.com\/ 500 \d+ ms/);
          });
      });
    });
  });
});
